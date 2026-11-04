# mirrored

what supaforge mirrors from insforge to supabase, operation by operation, and
the honest edges of each one. the endpoint-level detail lives in
[mapping.md](mapping.md).

## data writes

| insforge operation | supabase target |
| --- | --- |
| `POST/PATCH/DELETE /api/database/records/{t}` | `POST/PATCH/DELETE /rest/v1/{t}` (service role, filters preserved) |

reads (GET) pass through untouched: insforge stays the source of truth during
development. bodies over `maxMirrorBodyBytes` are proxied but not mirrored
(recorded as `skipped-too-large` so nothing disappears silently).

## schema

| insforge operation | supabase target |
| --- | --- |
| migration / raw sql (`db query`, `db migrations up` via the bridge) | management api `/v1/projects/{ref}/database/query` |

sql is split quote-aware (strings, dollar-quoted bodies, comments) so plpgsql
survives, then replayed with `set search_path to public`. statements touching
insforge's `realtime` schema are held back instead of failing the migration,
and saved to `.supaforge/skipped-realtime.sql` for porting (see realtime
below).

## storage

| insforge operation | supabase target |
| --- | --- |
| bucket create/delete (`/api/storage/buckets/...`) | `/storage/v1/bucket` |
| direct object upload (PUT `/objects/{key}`) | `/storage/v1/object/{bucket}/{key}` (upsert) |
| presigned-s3 upload confirmed (`/confirm-upload`) | bridge pulls the object from insforge, pushes it to supabase |

## auth

| insforge operation | supabase target |
| --- | --- |
| `POST /api/auth/users` with a password | `/auth/v1/admin/users` (best-effort) |

passwordless users (oauth, magic link) cannot be mirrored through the admin
api. their op parks as `failed` with a clear reason so cutover reconciles them
instead of silently losing them.

## edge functions

| insforge operation | supabase target |
| --- | --- |
| function deploy (`POST /api/functions`, `/api/functions/{slug}`, `/api/edge-functions`) | management api `POST /functions` (create) or `PATCH /functions/{slug}` (update, on 409) |

both platforms run deno, so the source carries over. the bridge reads the
function name and code out of the deploy payload whatever shape the cli or mcp
sent it in (a `code` string, a nested `function.code`, or a `files` map), then
creates or updates the supabase function with `verify_jwt: false`. multi-file
deploys go through the multipart `/functions/deploy` endpoint the supabase cli
itself uses.

what does not carry over: insforge cron schedules and database triggers
attached to a function are separate metadata, and supabase's equivalents are
different resources. port those by hand.

## realtime

insforge realtime is socket.io on top of an explicit publish model: a database
trigger calls `realtime.publish(channel, event, payload)`, and rls lives on
`realtime.channels` / `realtime.messages`. supabase realtime is a different
animal: phoenix-protocol channels fed by postgres wal through a publication,
with rls read from your own tables.

there is no faithful automatic translation between those two, so supaforge
does not pretend. instead it protects the migration:

- statements that reference the `realtime` schema (publish calls, channel rls,
  `realtime.channel_name()` helpers) are held back from the supabase replay,
  along with any trigger that depends on a held-back function, so a mirrored
  migration never fails because of realtime
- the held-back sql is appended to `.supaforge/skipped-realtime.sql`, quiet and
  inspectable, ready to be rewritten as supabase realtime channels plus a
  publication when you port the feature

porting recipe, when you get there: create a publication for the tables you
watch (`alter publication supabase_realtime add table public.orders;`), swap
the client from insforge's socket.io api to `supabase.channel(...).on('postgres_changes', ...)`,
and move channel authorization into rls policies on the watched tables.

## model gateway

no supabase counterpart exists. the gateway is an insforge product (one
openai-compatible endpoint across providers); supabase has nothing in that
slot. keep calling it until cutover, then point the same openai-compatible
client at whatever provider you actually want in production. nothing is
mirrored, and nothing breaks, because gateway calls never touch your database.

## durability of every mirrored op

every mirror op is written to an append-only ndjson journal
(`.supaforge/journal.ndjson`), applied sequentially (write order is preserved)
with bounded retries. anything that can't be applied parks as `failed` with the
error: fix the blocker, run `supaforge replay`, done. binary upload bodies go
to sidecar files (`.supaforge/bodies/`) so the journal stays lean.
