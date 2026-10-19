# supaforge-bridge

develop on insforge. ship on supabase. cutover without copy-paste.

supaforge-bridge is a zero-dependency local proxy you put between your coding
agent (insforge cli / mcp / sdk) and insforge. it forwards every request to
insforge untouched — and in the background, mirrors every state-changing
operation to a supabase project, continuously. when migration day comes,
supabase is already in sync. no mid-build copy-paste sessions, no "run this
sql in the supabase sql editor for me" loops.

```
                     ┌──────────────────────┐
 agent (cli/mcp/sdk)─▶│  supaforge-bridge     │──▶ insforge (forward everything)
                     │  :7131                │
                     │  mirror writes ──────│──▶ supabase (keep in sync)
                     └──────────────────────┘
```

the full endpoint-by-endpoint translation map lives in
[docs/mapping.md](docs/mapping.md).

## why this works

insforge's data api is postgrest v12 behind `/api/database/records/{table}`;
supabase's `/rest/v1/{table}` is postgrest too. so data writes translate with
the query string and body passed through nearly unchanged — only the path
shape and auth headers change. schema changes arrive as sql (insforge
migrations / `db query`), and the bridge replays that sql to supabase through
the supabase management api. no postgres wire protocol, no drivers, no deps.

## what gets mirrored

| insforge operation | supabase target |
| --- | --- |
| `POST/PATCH/DELETE /api/database/records/{t}` | `POST/PATCH/DELETE /rest/v1/{t}` (service role, filters preserved) |
| migration / raw sql (`db query`, `db migrations up` via the bridge) | management api `/v1/projects/{ref}/database/query` |
| bucket create/delete (`/api/storage/buckets/...`) | `/storage/v1/bucket` |
| direct object upload (PUT `/objects/{key}`) | `/storage/v1/object/{bucket}/{key}` (upsert) |
| presigned-s3 upload confirmed (`/confirm-upload`) | bridge pulls the object from insforge, pushes it to supabase |
| `POST /api/auth/users` with a password | `/auth/v1/admin/users` (best-effort; see cutover notes) |

reads (GET) pass through untouched — insforge stays the source of truth
during development. bodies over `maxMirrorBodyBytes` are proxied but not
mirrored (recorded as `skipped-too-large` so nothing disappears silently).

every mirror op is written to an append-only ndjson journal
(`.supaforge/journal.ndjson`), applied sequentially (write order is
preserved) with bounded retries. anything that can't be applied parks as
`failed` with the error — fix the blocker, run `replay`, done. binary upload
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
you develop against insforge — you just get a parallel supabase copy for free.

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
- edge functions (deno) — supabase has equivalents, but code differs
- model gateway calls (insforge-only concept)
- real production users — mirrored dev users are best-effort; use supabase's
  user-migration tooling for real accounts
- rls policies arrive with mirrored sql, but verify them — jwt claim shapes
  differ between the two platforms

## testing

```bash
npm test
# or
supaforge-bridge selftest
```

the suite runs against in-process mock insforge and mock supabase servers —
11 tests covering sql splitting, route classification, data mirroring,
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
