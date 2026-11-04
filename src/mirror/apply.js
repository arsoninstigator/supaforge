// Mirror appliers: translate a captured InsForge operation into the
// equivalent Supabase operation.
//
// The key insight: InsForge's data API is PostgREST, and Supabase's
// /rest/v1 is PostgREST too. So data writes translate with the query
// string and body passed through almost untouched — only the path shape
// and auth headers change.

import fs from "node:fs";
import path from "node:path";
import { jsonRequest, request } from "../util/http.js";
import { splitSql, extractSqlCandidates } from "../util/sqlsplit.js";

let log = () => {};
export function setMirrorLogger(fn) { log = fn; }

function supaHeaders(cfg, extra = {}) {
  return {
    apikey: cfg.supabase.serviceRoleKey,
    authorization: `Bearer ${cfg.supabase.serviceRoleKey}`,
    ...extra,
  };
}

function mgmtUrl(cfg, pathname) {
  const base = cfg.supabase.mgmtBaseUrl.replace(/\/$/, "");
  return `${base}/v1/projects/${cfg.supabase.projectRef}${pathname}`;
}

// ---------- data (PostgREST -> PostgREST) ----------

async function mirrorData(cfg, rec) {
  const url = `${cfg.supabase.url.replace(/\/$/, "")}/rest/v1/${encodeURIComponent(rec.table)}${rec.query || ""}`;
  const method = rec.type === "data-insert" ? "POST" : rec.type === "data-update" ? "PATCH" : "DELETE";
  const headers = supaHeaders(cfg, {
    "content-type": "application/json",
    accept: "application/json",
    prefer: "return=minimal",
  });
  const body = rec.type === "data-delete" ? undefined : JSON.stringify(rec.body);
  const res = await request(method, url, { headers, body });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    const err = new Error(`Supabase ${method} /rest/v1/${rec.table} -> ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  await res.text().catch(() => {});
}

// ---------- schema (SQL -> Supabase Management API) ----------

async function runSqlOnSupabase(cfg, query) {
  try {
    // Preferred: one call, all statements (migrations mirror atomically enough
    // for dev; each statement runs sequentially on the management endpoint).
    await jsonRequest("POST", mgmtUrl(cfg, "/database/query"), {
      headers: { authorization: `Bearer ${cfg.supabase.accessToken}` },
      body: { query: `set search_path to public;\n${query}` },
    });
  } catch (err) {
    const msg = String(err.message || err);
    // Some management API versions reject multi-statement payloads.
    if (!/multi|multiple statements|cannot insert multiple commands/i.test(msg)) throw err;
    const statements = splitSql(query);
    for (const stmt of statements) {
      await jsonRequest("POST", mgmtUrl(cfg, "/database/query"), {
        headers: { authorization: `Bearer ${cfg.supabase.accessToken}` },
        body: { query: `set search_path to public;\n${stmt}` },
      });
    }
  }
}

// insforge realtime lives in a `realtime` schema that supabase does not have:
// triggers call realtime.publish(), policies target realtime.channels, and
// helpers like realtime.channel_name() resolve there. replaying those to
// supabase would fail the whole migration, so they are held back, written to
// .supaforge/skipped-realtime.sql for porting, and reported.
const REALTIME_SQL_RE = /\brealtime\.(publish|channels|messages|channel_name)\b|create\s+schema\s+(if\s+not\s+exists\s+)?realtime\b/i;
const CREATE_FN_RE = /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)/i;
const TRIGGER_FN_RE = /execute\s+(?:function|procedure)\s+([\w.]+)/i;

function planSqlForSupabase(statements) {
  const blocked = [];
  const blockedFunctions = new Set();
  for (const stmt of statements) {
    if (REALTIME_SQL_RE.test(stmt)) {
      blocked.push(stmt);
      const m = stmt.match(CREATE_FN_RE);
      if (m) blockedFunctions.add(m[1].replace(/^public\./i, "").toLowerCase());
    }
  }
  const runnable = statements.filter((stmt) => {
    if (blocked.includes(stmt)) return false;
    const m = stmt.match(TRIGGER_FN_RE);
    if (m && blockedFunctions.has(m[1].replace(/^public\./i, "").toLowerCase())) {
      blocked.push(stmt); // trigger would reference a function we did not create
      return false;
    }
    return true;
  });
  return { runnable, blocked };
}

function recordSkippedRealtime(cfg, blocked) {
  const dir = (cfg.bridge && cfg.bridge.stateDir) || ".supaforge";
  const file = path.join(dir, "skipped-realtime.sql");
  fs.mkdirSync(dir, { recursive: true });
  const banner = `-- held back from supabase replay at ${new Date().toISOString()}\n-- insforge realtime schema has no supabase counterpart; port these to supabase realtime channels + publication.\n\n`;
  fs.appendFileSync(file, banner + blocked.join(";\n\n") + ";\n\n");
  return file;
}

async function mirrorSql(cfg, rec) {
  const scripts = rec.sql ? [rec.sql] : extractSqlCandidates(rec.body);
  if (scripts.length === 0) {
    throw new Error("no SQL found in payload to mirror");
  }
  for (const script of scripts) {
    const statements = splitSql(script);
    if (statements.length === 0) continue;
    const { runnable, blocked } = planSqlForSupabase(statements);
    if (blocked.length > 0) {
      const file = recordSkippedRealtime(cfg, blocked);
      log(`realtime: held back ${blocked.length} insforge realtime statement(s) from supabase; saved to ${file}`);
    }
    if (runnable.length === 0) continue;
    await runSqlOnSupabase(cfg, runnable.join(";\n") + ";");
  }
}

// ---------- auth (best-effort user mirror) ----------

async function mirrorAuthUser(cfg, rec) {
  const b = rec.body || {};
  const email = b.email;
  const password = b.password || b.plaintext_password;
  if (!email) throw new Error("auth mirror: no email in payload");
  if (!password) {
    // Users without a password (OAuth/magic-link dev users) can't be mirrored
    // via the admin API. Park the op so cutover knows to reconcile.
    throw new Error(`auth mirror: user ${email} has no password; create them in Supabase at cutover`);
  }
  await jsonRequest("POST", `${cfg.supabase.url.replace(/\/$/, "")}/auth/v1/admin/users`, {
    headers: supaHeaders(cfg),
    body: {
      email,
      password,
      email_confirm: b.email_confirmed ?? b.email_verified ?? true,
      user_metadata: b.user_metadata ?? b.metadata ?? {},
    },
  });
}

// ---------- storage ----------

async function mirrorBucketCreate(cfg, rec) {
  const name = rec.bucket || (rec.body && (rec.body.name || rec.body.bucketName));
  if (!name) throw new Error("bucket mirror: no bucket name found");
  const res = await request("POST", `${cfg.supabase.url.replace(/\/$/, "")}/storage/v1/bucket`, {
    headers: supaHeaders(cfg, { "content-type": "application/json" }),
    body: JSON.stringify({ name, public: rec.body?.public ?? true }),
  });
  if (!res.ok) {
    const err = new Error(`Supabase bucket create -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  await res.text().catch(() => {});
}

async function mirrorBucketDelete(cfg, rec) {
  if (!rec.bucket) throw new Error("bucket mirror: no bucket name found");
  const res = await request("DELETE", `${cfg.supabase.url.replace(/\/$/, "")}/storage/v1/bucket/${encodeURIComponent(rec.bucket)}`, {
    headers: supaHeaders(cfg),
  });
  if (!res.ok) throw new Error(`Supabase bucket delete -> ${res.status}`);
  await res.text().catch(() => {});
}

async function mirrorObjectUpload(cfg, rec) {
  const body = rec.body ?? (rec.bodyPath ? fs.readFileSync(rec.bodyPath) : null);
  if (body == null) throw new Error("object mirror: body not captured (too large?)");
  const url = `${cfg.supabase.url.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(rec.bucket)}/${rec.key}${rec.query || ""}`;
  const res = await request("POST", url, {
    headers: supaHeaders(cfg, {
      "content-type": rec.contentType || "application/octet-stream",
      "x-upsert": "true",
    }),
    body: Buffer.isBuffer(body) ? body : typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body)),
  });
  if (!res.ok) {
    const err = new Error(`Supabase object upload -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  await res.text().catch(() => {});
}

async function mirrorObjectUploadConfirm(cfg, rec) {
  // Presigned S3 uploads bypass the bridge, so at confirm time we pull the
  // finished object out of InsForge and push it to Supabase.
  const srcUrl = `${cfg.insforge.baseUrl.replace(/\/$/, "")}/api/storage/buckets/${encodeURIComponent(rec.bucket)}/objects/${rec.key}`;
  const srcRes = await request("GET", srcUrl, {
    headers: { authorization: `Bearer ${cfg.insforge.adminKey}` },
    timeoutMs: 60000,
  });
  if (!srcRes.ok) throw new Error(`InsForge object fetch -> ${srcRes.status}`);
  const buf = Buffer.from(await srcRes.arrayBuffer());
  await mirrorObjectUpload(cfg, { ...rec, body: buf, contentType: srcRes.headers.get("content-type") || undefined });
}

async function mirrorObjectDelete(cfg, rec) {
  const res = await request("DELETE", `${cfg.supabase.url.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(rec.bucket)}/${rec.key}`, {
    headers: supaHeaders(cfg),
  });
  if (!res.ok) throw new Error(`Supabase object delete -> ${res.status}`);
  await res.text().catch(() => {});
}

// ---------- edge functions (deno -> supabase edge functions) ----------

function pickFunctionMeta(rec) {
  const b = rec.body && typeof rec.body === "object" ? rec.body : {};
  const inner = b.function && typeof b.function === "object" ? b.function : {};
  const slug = rec.slug || b.slug || b.name || b.functionName || inner.slug || inner.name;
  let code = b.code || b.body || b.source || b.sourceCode || b.content || inner.code;
  const files = b.files || inner.files || null;
  if (!code && files) {
    if (Array.isArray(files)) {
      const entry = files.find((f) => /index\.[tj]sx?$/.test(f.name || f.path || "")) || files[0];
      code = entry && (entry.content || entry.source);
    } else if (typeof files === "object") {
      const key = Object.keys(files).find((k) => /index\.[tj]sx?$/.test(k)) || Object.keys(files)[0];
      code = files[key];
    }
  }
  if (!code && typeof rec.body === "string") code = rec.body;
  return { slug, code, files };
}

async function mirrorFunctionDeploy(cfg, rec) {
  const { slug, code, files } = pickFunctionMeta(rec);
  if (!slug) throw new Error("function mirror: no function name/slug in deploy payload");
  if (!code && !files) throw new Error(`function mirror: no source found for "${slug}"`);
  const headers = { authorization: `Bearer ${cfg.supabase.accessToken}` };

  // single-file: management api accepts json {slug, name, body, verify_jwt}
  if (typeof code === "string") {
    const res = await request("POST", mgmtUrl(cfg, "/functions"), {
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: slug, body: code, verify_jwt: false }),
    });
    if (res.ok) { await res.text().catch(() => {}); return; }
    if (res.status === 409) {
      const patch = await request("PATCH", mgmtUrl(cfg, `/functions/${encodeURIComponent(slug)}`), {
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ body: code, verify_jwt: false }),
      });
      if (patch.ok) { await patch.text().catch(() => {}); return; }
      const err = new Error(`supabase function update -> ${patch.status}: ${(await patch.text()).slice(0, 300)}`);
      err.status = patch.status;
      throw err;
    }
    const err = new Error(`supabase function create -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  // multi-file: multipart deploy, the shape supabase cli uses
  const form = new FormData();
  const entries = Array.isArray(files)
    ? files.map((f) => [f.name || f.path, f.content ?? f.source])
    : Object.entries(files);
  for (const [name, content] of entries) {
    form.append("file", new Blob([String(content ?? "")], { type: "application/typescript" }), name);
  }
  form.append("metadata", JSON.stringify({ entrypoint_path: entries[0][0], name: slug, verify_jwt: false }));
  const res = await request("POST", mgmtUrl(cfg, `/functions/deploy?slug=${encodeURIComponent(slug)}`), {
    headers,
    body: form,
  });
  if (!res.ok) {
    const err = new Error(`supabase function deploy -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  await res.text().catch(() => {});
}

export async function applyMirrorOp(cfg, rec) {
  switch (rec.type) {
    case "data-insert":
    case "data-update":
    case "data-delete":
      return mirrorData(cfg, rec);
    case "sql":
      return mirrorSql(cfg, rec);
    case "auth-user":
      return mirrorAuthUser(cfg, rec);
    case "function-deploy":
      return mirrorFunctionDeploy(cfg, rec);
    case "bucket-create":
      return mirrorBucketCreate(cfg, rec);
    case "bucket-delete":
      return mirrorBucketDelete(cfg, rec);
    case "object-upload":
      return mirrorObjectUpload(cfg, rec);
    case "object-upload-confirm":
      return mirrorObjectUploadConfirm(cfg, rec);
    case "object-delete":
      return mirrorObjectDelete(cfg, rec);
    default:
      throw new Error(`unknown mirror op type: ${rec.type}`);
  }
}
