# supaforge-bridge

develop on insforge, ship on supabase. the agent stays autonomous, production stays trusted, and nobody copy-pastes sql between dashboards.

## the problem case

two backends, two strengths, one tension.

supabase is what you trust for production. it's battle-tested: years of hardening, a huge user base, managed postgres you'd happily bet a real product on. but it assumes a human in the loop. schema changes happen through the sql editor or dashboard, settings and keys live in the console, and in practice agentic development keeps ending with "now go run this in supabase yourself." the agent can write the migration, but you are the one who carries it over.

insforge is what your agent can actually run. it's built for agentic coding: an mcp server and a cli expose the whole backend, so the agent creates tables, applies migrations, manages storage and auth, all on its own, with no human in the loop during the build. but it's young. you feel it. you don't want to bet production on it yet.

so the tension is this: autonomous development needs the agent to own the backend. production trust needs supabase. and moving between them mid-project means a human becomes the bridge: copy the sql out of insforge, paste it into the supabase sql editor, verify, repeat. every migration, every table, every bucket, every time. the agent stops and waits. you do chores. this is the exact loop supaforge-bridge deletes.

the bridge is that human, automated away. you develop entirely on insforge, where the agent works autonomously. the bridge sits in the middle, forwards everything to insforge, and in the background replays every state-changing operation to your supabase project: data writes, migration sql, storage, users. supabase stays continuously in sync without you touching its dashboard once during the build. when it's time to ship, the production database is already ready, because it has been ready the whole time. cutover is a flip, not a project.

best of both worlds isn't a side effect, it's the design: insforge for the build, where autonomy lives. supabase for production, where trust lives. supaforge-bridge for the space between.

## how it works

```
                     ┌──────────────────────┐
 agent (cli/mcp/sdk)─▶│  supaforge-bridge     │──▶ insforge (forward everything)
                     │  :7131                │
                     │  mirror writes ──────│──▶ supabase (keep in sync)
                     └──────────────────────┘
```

insforge's data api is postgrest v12 behind `/api/database/records/{table}`;
supabase's `/rest/v1/{table}` is postgrest too. so data writes translate with
the query string and body passed through nearly unchanged, only the path
shape and auth headers change. schema changes arrive as sql (insforge
migrations / `db query`), and the bridge replays that sql to supabase through
the supabase management api. no postgres wire protocol, no drivers, no deps.

the full endpoint-by-endpoint translation map lives in
[docs/mapping.md](docs/mapping.md).

## what gets mirrored

| insforge operation | supabase target |
| --- | --- |
| `POST/PATCH/DELETE /api/database/records/{t}` | `POST/PATCH/DELETE /rest/v1/{t}` (service role, filters preserved) |
| migration / raw sql (`db query`, `db migrations up` via the bridge) | management api `/v1/projects/{ref}/database/query` |
| bucket create/delete (`/api/storage/buckets/...`) | `/storage/v1/bucket` |
| direct object upload (PUT `/objects/{key}`) | `/storage/v1/object/{bucket}/{key}` (upsert) |
| presigned-s3 upload confirmed (`/confirm-upload`) | bridge pulls the object from insforge, pushes it to supabase |
| `POST /api/auth/users` with a password | `/auth/v1/admin/users` (best-effort; see cutover notes) |

reads (GET) pass through untouched: insforge stays the source of truth during
development. bodies over `maxMirrorBodyBytes` are proxied but not mirrored
(recorded as `skipped-too-large` so nothing disappears silently).

every mirror op is written to an append-only ndjson journal
(`.supaforge/journal.ndjson`), applied sequentially (write order is
preserved) with bounded retries. anything that can't be applied parks as
`failed` with the error: fix the blocker, run `replay`, done. binary upload
bodies go to sidecar files (`.supaforge/bodies/`) so the journal stays lean.

## setup

```bash
supaforge-bridge init        # writes supaforge.config.json (or use env vars)
```

fill in:

- `insforge.baseUrl` — where insforge runs (e.g. `http://localhost:7130`)
- `insforge.adminKey` — your insforge admin/access key (needed for
  confirm-upload pulls and cutover introspection)
- `insforge.sqlPath` — insforge's raw-sql endpoint. default
  `/api/database/query`; adjust if your deployment differs.
- `supabase.url` — e.g. `https://xyzcompany.supabase.co`
- `supabase.serviceRoleKey` — for data/storage/auth mirroring
- `supabase.accessToken` + `supabase.projectRef` — a supabase personal access
  token (`sbp_...`) and project ref, used to run mirrored sql via the
  management api

environment variable equivalents: `INSFORGE_URL`, `INSFORGE_ADMIN_KEY`,
`INSFORGE_SQL_PATH`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPAFORGE_PORT`.

## running

```bash
supaforge-bridge start
```

then point your agent's insforge base url at the bridge instead of insforge:

- sdk: `new InsForgeClient({ baseUrl: "http://127.0.0.1:7131", ... })`
- insforge cli (self-hosted): point the api base url at the bridge
- mcp: connect the mcp server through the bridge url

everything that isn't recognized is proxied verbatim, so nothing breaks while
you develop against insforge. you just get a parallel supabase copy for free.

## daily commands

```bash
supaforge-bridge status          # journal stats + failed ops
supaforge-bridge replay          # retry parked/failed ops after fixing a blocker
supaforge-bridge sql -f migration.sql
                                 # run the same sql on both sides in one shot
supaforge-bridge cutover-check   # schema + approximate row-count drift report
```

`cutover-check` introspects both databases (insforge via its raw-sql
endpoint, supabase via the management api) and reports tables missing on
either side, column/type mismatches, and row-count drift, plus any mirror ops
still queued.

## cutover day

```bash
supaforge-bridge cutover          # writes .env.cutover + prints the checklist
supaforge-bridge start --mode front
```

`--mode front` flips the bridge's direction: it now *serves* the
insforge-shaped api (`/api/database/records/...`, object downloads, password
sign-in) but executes everything against supabase. your app keeps working
with zero code changes while you rewrite endpoints to native supabase at your
own pace. untranslated endpoints return an explicit 501 with a hint rather
than pretending to work.

### not mirrored (port these manually)

- realtime subscriptions and broadcasts
- edge functions (deno): supabase has equivalents, but code differs
- model gateway calls (insforge-only concept)
- real production users: mirrored dev users are best-effort; use supabase's
  user-migration tooling for real accounts
- rls policies arrive with mirrored sql, but verify them: jwt claim shapes
  differ between the two platforms

## testing

```bash
npm test
# or
supaforge-bridge selftest
```

the suite runs against in-process mock insforge and mock supabase servers: 11
tests covering sql splitting, route classification, data mirroring,
migration capture, storage mirroring (direct + presigned-confirm), auth
mirroring, failure/retry/replay, journal durability across restarts,
cutover drift detection, and front-mode serving. no external services
required.

## honest limitations

- mirrored inserts are retried on ambiguous failures (timeouts), which can
  duplicate rows; the queue prefers failing over guessing. check
  `cutover-check` row counts before flipping.
- insforge cli/mcp payload shapes evolve; sql capture scans request bodies
  for sql-looking content rather than hardcoding one shape, and
  `insforge.sqlPath` is configurable.
- the bridge holds your supabase service-role key locally. treat
  `supaforge.config.json` and `.supaforge/` like secrets (they're gitignored
  by `supaforge-bridge init`; verify).

## license

mit
