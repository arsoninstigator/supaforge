# supaforge-bridge mapping

the complete, detailed translation map between insforge and supabase.
source facts verified against the official docs on 2026-10-15:
insforge data api = postgrest v12.2 behind `/api/database/records/{table}`;
supabase data api = postgrest behind `/rest/v1/{table}`; supabase management
api accepts arbitrary sql at `/v1/projects/{ref}/database/query`; insforge
storage exposes `/api/storage/buckets/...` plus an s3 gateway; supabase
storage serves `/storage/v1/...`.

## 1. data (postgrest -> postgrest, mirror mode)

| thing | insforge | supabase | translation |
| --- | --- | --- | --- |
| query rows | `GET /api/database/records/{table}?{filters}` | `GET /rest/v1/{table}?{filters}` | passthrough in front mode; reads never mirrored |
| insert rows | `POST /api/database/records/{table}` | `POST /rest/v1/{table}` | body (must be an array, same in both) passed through verbatim; `prefer: return=minimal` added |
| update rows | `PATCH /api/database/records/{table}?{filters}` | `PATCH /rest/v1/{table}?{filters}` | query string passed through verbatim — both are postgrest syntax (`col=eq.value`, `col=neq.value`, etc.) |
| delete rows | `DELETE /api/database/records/{table}?{filters}` | `DELETE /rest/v1/{table}?{filters}` | query string passed through verbatim |
| order/limit/offset/select | `order=created_at.desc&limit=10&offset=0&select=a,b` | same | identical postgrest syntax, no translation needed |
| auth header | `authorization: bearer <insforge jwt or anon key>` | `apikey: <service role key>` + `authorization: bearer <service role key>` | bridge rewrites auth to its configured service role key for the mirror call |

why this is safe: both platforms run postgrest over postgres, so column
names, filter operators, ordering, and range headers all behave the same.
the only divergence is the url shape and the auth envelope.

## 2. schema / sql (mirror mode)

| thing | insforge | supabase | translation |
| --- | --- | --- | --- |
| migration apply (cli `db migrations up`) | http call into insforge's api carrying the sql | `POST api.supabase.com/v1/projects/{ref}/database/query` `{query}` | bridge captures the payload, scans it for sql (fields named sql/query/statements/content or any sql-looking string), splits statements, prefixes `set search_path to public;`, runs on supabase |
| raw sql (cli `db query`) | `POST /api/database/query` (configurable via `insforge.sqlPath`) | same management api path | same capture-and-replay as above |
| one-shot push | `supaforge-bridge sql -f file.sql` | same | applies to insforge first (source of truth), then supabase |

sql splitting respects single/double quotes, dollar-quoted bodies
(`$$ ... $$`, `$tag$ ... $tag$`), `--` line comments and `/* */` block
comments, so plpgsql function bodies never get chopped. if the management
api rejects a multi-statement payload, the bridge falls back to applying
statements one by one.

## 3. storage (mirror mode)

| thing | insforge | supabase | translation |
| --- | --- | --- | --- |
| create bucket | `POST /api/storage/buckets/{name}` (admin) | `POST /storage/v1/bucket` `{name, public}` | name from path or body; public flag passed through (default true) |
| delete bucket | `DELETE /api/storage/buckets/{name}` | `DELETE /storage/v1/bucket/{name}` | passthrough of name |
| direct upload (local backend) | `PUT /api/storage/buckets/{b}/objects/{key}` | `POST /storage/v1/object/{b}/{key}` + `x-upsert: true` | body captured (sidecar file if binary), content-type preserved |
| presigned upload (s3 backend) | upload goes browser -> s3 directly, bypassing the bridge; client then calls `POST .../objects/{key}/confirm-upload` | same as direct upload | at confirm time the bridge pulls the finished object from insforge (admin key) and pushes it to supabase |
| delete object | `DELETE /api/storage/buckets/{b}/objects/{key}` | `DELETE /storage/v1/object/{b}/{key}` | passthrough |
| downloads/lists | `GET ...` | — | never mirrored (reads); insforge stays the dev source of truth |

bodies larger than `maxMirrorBodyBytes` (default 50 mb) are proxied but not
mirrored; the op is journaled as `skipped-too-large` so it can be pushed
manually.

## 4. auth (mirror mode, best-effort)

| thing | insforge | supabase | translation |
| --- | --- | --- | --- |
| create user with password | `POST /api/auth/users` `{email, password, ...}` | `POST /auth/v1/admin/users` `{email, password, email_confirm, user_metadata}` | mirrored with `email_confirm: true` for dev |
| create user without password | `POST /api/auth/users` `{email}` (oauth/magic-link dev users) | — | cannot be mirrored (admin api needs a password); op parks as `failed` with a clear reason so cutover reconciles |
| sessions/refresh/verify | `/api/auth/sessions`, `/api/auth/refresh`, ... | `/auth/v1/token` etc. | not mirrored (they create tokens, not state) |

honest note: passwords mirrored this way land in supabase's auth system
correctly, but real production users should be migrated with supabase's
user-migration tooling at cutover, not by the bridge.

## 5. not mirrored (by design)

- realtime subscriptions and broadcasts (insforge and supabase wire formats
  differ; port at cutover)
- edge functions (insforge deno functions vs supabase edge functions —
  similar model, different deploy api)
- model gateway calls (insforge-only product)
- read traffic of any kind

## 6. front mode (after cutover, reverse direction)

serves the insforge-shaped api your app was written against, backed by
supabase:

| insforge-shaped request | executed against supabase | notes |
| --- | --- | --- |
| `GET/POST/PATCH/DELETE /api/database/records/{t}?{filters}` | same method on `/rest/v1/{t}?{filters}` | filters/order/limit identical; body verbatim; `content-range` header forwarded |
| `GET /api/storage/buckets/{b}/objects/{key}` | `GET /storage/v1/object/{b}/{key}` | service role auth, bytes streamed back |
| `GET /api/storage/buckets` | `GET /storage/v1/bucket` | bucket list |
| `POST /api/auth/sessions` `{email,password}` | `POST /auth/v1/token?grant_type=password` | response reshaped to `{user, session:{access_token, refresh_token}}` |
| `POST /api/auth/refresh` `{refresh_token}` | `POST /auth/v1/token?grant_type=refresh_token` | response reshaped likewise |
| anything else | — | explicit 501 with a hint, never a silent fake |

## 7. durability

every mirror op is written to `.supaforge/journal.ndjson` (append-only,
envelope field `evt`) before it is attempted, then applied sequentially so
write order is preserved. ops retry up to 3 times with backoff; a hard 4xx
fails immediately (retrying a 404 won't fix it), a 5xx or network error
retries. terminal failures park as `failed` with the error text and are
re-applied by `supaforge-bridge replay` after the blocker is fixed. binary
upload bodies live in `.supaforge/bodies/*.bin` sidecars referenced by
`bodyPath`, keeping the journal lean.
