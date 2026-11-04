# supaforge

develop on insforge, ship on supabase. the agent stays autonomous, production stays trusted, and nobody copy-pastes sql between dashboards.

## the problem case

two backends, two strengths, one tension.

supabase is what you trust for production. it's battle-tested: years of hardening, a huge user base, managed postgres you'd happily bet a real product on. but it assumes a human in the loop. schema changes happen through the sql editor or dashboard, settings and keys live in the console, and in practice agentic development keeps ending with "now go run this in supabase yourself." the agent can write the migration, but you are the one who carries it over.

insforge is what your agent can actually run. it's built for agentic coding: an mcp server and a cli expose the whole backend, so the agent creates tables, applies migrations, manages storage and auth, all on its own, with no human in the loop during the build. but it's young. you feel it. you don't want to bet production on it yet.

so the tension is this: autonomous development needs the agent to own the backend. production trust needs supabase. and moving between them mid-project means a human becomes the bridge: copy the sql out of insforge, paste it into the supabase sql editor, verify, repeat. every migration, every table, every bucket, every time. the agent stops and waits. you do chores. this is the exact loop supaforge deletes.

supaforge is that human, automated away. you develop entirely on insforge, where the agent works autonomously. the bridge sits in the middle, forwards everything to insforge, and in the background replays every state-changing operation to your supabase project: data writes, migration sql, storage, edge functions, users. supabase stays continuously in sync without you touching its dashboard once during the build. when it's time to ship, the production database is already ready, because it has been ready the whole time. cutover is a flip, not a project.

best of both worlds isn't a side effect, it's the design: insforge for the build, where autonomy lives. supabase for production, where trust lives. supaforge for the space between.

## install

```bash
npm i -g getsupaforge     # installs the `supaforge` command
```

or without installing:

```bash
npx getsupaforge start
```

then:

```bash
supaforge --version
supaforge start
supaforge --status
```

every command answers as a subcommand or a leading flag (`supaforge status`
and `supaforge --status` are the same thing).

a note on the package name, since three npm rules shaped it:

1. `supaforge` itself was published and fully unpublished in march 2026, which
   spends 0.1.0, 0.1.1, 0.1.3 and 0.1.4 forever, and its unscoped name is
   blocked by a typosquat guard against the live `supa-forge`.
2. so the package is `getsupaforge`. the binary it installs is `supaforge`.
3. `@tinkrland/supaforge` was the first scoped publish and is now deprecated
   in favour of `getsupaforge`; its 0.2.0 is left in place and points here.

## how it works

```
                     ┌──────────────────────┐
 agent (cli/mcp/sdk)─▶│  supaforge            │──▶ insforge (forward everything)
                     │  :7131                │
                     │  mirror writes ──────│──▶ supabase (keep in sync)
                     └──────────────────────┘
```

insforge's data api is postgrest v12 behind `/api/database/records/{table}`;
supabase's `/rest/v1/{table}` is postgrest too. so data writes translate with
the query string and body passed through nearly unchanged, only the path
shape and auth headers change. schema changes arrive as sql (insforge
migrations / `db query`), and supaforge replays that sql to supabase through
the supabase management api. no postgres wire protocol, no drivers, no deps.

- [docs/mirrored.md](docs/mirrored.md): what gets mirrored, operation by operation, including the honest edges (realtime, model gateway)
- [docs/mapping.md](docs/mapping.md): the endpoint-level translation map in both directions

## setup

```bash
supaforge init        # writes supaforge.config.json (or use env vars)
```

fill in:

- `insforge.baseUrl` — where insforge runs (e.g. `http://localhost:7130`)
- `insforge.adminKey` — your insforge admin/access key (needed for
  confirm-upload pulls and cutover introspection)
- `insforge.sqlPath` — insforge's raw-sql endpoint. default
  `/api/database/query`; adjust if your deployment differs.
- `supabase.url` — e.g. `https://xyzcompany.supabase.co`
- `supabase.serviceRoleKey` — for data/storage/auth/function mirroring
- `supabase.accessToken` + `supabase.projectRef` — a supabase personal access
  token (`sbp_...`) and project ref, used to run mirrored sql and deploy
  functions via the management api

environment variable equivalents: `INSFORGE_URL`, `INSFORGE_ADMIN_KEY`,
`INSFORGE_SQL_PATH`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPAFORGE_PORT`.

## running

```bash
supaforge start
```

then point your agent's insforge base url at the bridge instead of insforge:

- sdk: `new InsForgeClient({ baseUrl: "http://127.0.0.1:7131", ... })`
- insforge cli (self-hosted): point the api base url at the bridge
- mcp: connect the mcp server through the bridge url

everything that isn't recognized is proxied verbatim, so nothing breaks while
you develop against insforge. you just get a parallel supabase copy for free.

## daily commands

```bash
supaforge status          # journal stats + failed ops
supaforge replay          # retry parked/failed ops after fixing a blocker
supaforge sql -f migration.sql
                          # run the same sql on both sides in one shot
supaforge cutover-check   # schema + approximate row-count drift report
```

`cutover-check` introspects both databases (insforge via its raw-sql
endpoint, supabase via the management api) and reports tables missing on
either side, column/type mismatches, and row-count drift, plus any mirror ops
still queued.

## cutover day

```bash
supaforge cutover          # writes .env.cutover + prints the checklist
supaforge start --mode front
```

`--mode front` flips the bridge's direction: it now *serves* the
insforge-shaped api (`/api/database/records/...`, object downloads, password
sign-in) but executes everything against supabase. your app keeps working
with zero code changes while you rewrite endpoints to native supabase at your
own pace. untranslated endpoints return an explicit 501 with a hint rather
than pretending to work.

### what still needs porting

- realtime: held back and saved for you, not translated (see docs/mirrored.md)
- model gateway calls: no supabase counterpart exists
- cron schedules and database triggers attached to edge functions
- real production users: mirrored dev users are best-effort; use supabase's
  user-migration tooling for real accounts
- rls policies arrive with mirrored sql, but verify them: jwt claim shapes
  differ between the two platforms

## testing

```bash
npm test
# or
supaforge selftest
```

the suite runs against in-process mock insforge and mock supabase servers: 13
tests covering sql splitting, route classification, data mirroring,
migration capture, the realtime guard, storage mirroring (direct +
presigned-confirm), auth mirroring, edge function deploys, failure/retry/replay,
journal durability across restarts, cutover drift detection, and front-mode
serving. no external services required.

## publishing (maintainer notes)

```bash
npm run preflight   # packs a real tarball, installs it into a temp prefix,
                    # runs the installed binary, checks npm auth + name state
npm publish
```

## honest limitations

- mirrored inserts are retried on ambiguous failures (timeouts), which can
  duplicate rows; the queue prefers failing over guessing. check
  `cutover-check` row counts before flipping.
- insforge cli/mcp payload shapes evolve; sql and function capture scan request
  bodies for sql- or code-looking content rather than hardcoding one shape, and
  `insforge.sqlPath` is configurable.
- the bridge holds your supabase service-role key locally. treat
  `supaforge.config.json` and `.supaforge/` like secrets.

## license

mit
