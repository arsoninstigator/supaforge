// Route classifier: decides what an incoming request is and whether/how it
// should be mirrored to Supabase.

// InsForge data API is PostgREST behind /api/database/records/{table}.
const RECORDS_RE = /^\/api\/database\/records\/([^/?]+)/;

// Paths that carry SQL when the InsForge CLI/MCP applies migrations or runs
// raw queries. Matched loosely — the SQL itself is extracted from the body.
const SQL_PATH_RE = /^\/api\/(database\/(query|sql|execute-sql|run-sql|migrations?)|cli\/db\/(query|migrations?)|migrations?)/;

// InsForge storage (REST) paths.
const BUCKET_OBJECTS_RE = /^\/api\/storage\/buckets\/([^/]+)\/objects\/(.+?)(\/confirm-upload)?$/;
const BUCKETS_ADMIN_RE = /^\/api\/storage\/buckets\/?([^/]*)$/;

// InsForge auth paths worth mirroring.
const AUTH_USERS_RE = /^\/api\/auth\/users\/?$/;

export function classify(req) {
  const url = new URL(req.url, "http://bridge.local");
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method.toUpperCase();

  const info = { kind: "passthrough", method, pathname, query: url.search };

  const records = pathname.match(RECORDS_RE);
  if (records) {
    info.kind = "data";
    info.table = records[1];
    return info;
  }
  if (SQL_PATH_RE.test(pathname)) {
    info.kind = "sql";
    return info;
  }
  const obj = pathname.match(BUCKET_OBJECTS_RE);
  if (obj) {
    info.kind = obj[3] ? "storage-confirm" : "storage-object";
    info.bucket = obj[1];
    info.key = obj[2];
    return info;
  }
  const bucket = pathname.match(BUCKETS_ADMIN_RE);
  if (bucket) {
    info.kind = "storage-bucket";
    info.bucket = bucket[1] || null;
    return info;
  }
  if (AUTH_USERS_RE.test(pathname) && (method === "POST" || method === "PUT")) {
    info.kind = "auth-user";
    return info;
  }
  return info;
}

// Only these kinds + methods produce mirror operations.
export function mirrorOpFor(info, body) {
  switch (info.kind) {
    case "data":
      if (info.method === "POST") return { type: "data-insert", table: info.table, query: info.query, body };
      if (info.method === "PATCH") return { type: "data-update", table: info.table, query: info.query, body };
      if (info.method === "DELETE") return { type: "data-delete", table: info.table, query: info.query };
      return null;
    case "sql":
      if (info.method === "POST" || info.method === "PUT") return { type: "sql", body };
      return null;
    case "storage-bucket":
      if (info.method === "POST") return { type: "bucket-create", bucket: info.bucket || (body && body.name), body };
      if (info.method === "DELETE") return { type: "bucket-delete", bucket: info.bucket };
      return null;
    case "storage-object":
      if (info.method === "PUT" || info.method === "POST") {
        return { type: "object-upload", bucket: info.bucket, key: info.key, query: info.query, body };
      }
      if (info.method === "DELETE") return { type: "object-delete", bucket: info.bucket, key: info.key };
      return null;
    case "storage-confirm":
      return { type: "object-upload-confirm", bucket: info.bucket, key: info.key };
    case "auth-user":
      return { type: "auth-user", body };
    default:
      return null;
  }
}
