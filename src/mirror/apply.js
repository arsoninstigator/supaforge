// Mirror appliers: translate a captured InsForge operation into the
// equivalent Supabase operation.
//
// The key insight: InsForge's data API is PostgREST, and Supabase's
// /rest/v1 is PostgREST too. So data writes translate with the query
// string and body passed through almost untouched — only the path shape
// and auth headers change.

import fs from "node:fs";
import { jsonRequest, request } from "../util/http.js";
import { splitSql, extractSqlCandidates } from "../util/sqlsplit.js";

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

async function mirrorSql(cfg, rec) {
  // `rec.sql` is used by the `supaforge-bridge sql` command; `rec.body` is a
  // captured CLI/MCP payload of unknown shape — scan it for SQL strings.
  const scripts = rec.sql ? [rec.sql] : extractSqlCandidates(rec.body);
  if (scripts.length === 0) {
    throw new Error("no SQL found in payload to mirror");
  }
  for (const script of scripts) {
    const statements = splitSql(script);
    if (statements.length === 0) continue;
    await runSqlOnSupabase(cfg, statements.join(";\n") + ";");
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
