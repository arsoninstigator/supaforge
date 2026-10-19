// supabase-front mode: after cutover, keep serving the InsForge-shaped API
// your app was written against, but back it with Supabase. The point is a
// zero-code-change cutover — you rewrite endpoints to native Supabase
// gradually, or never.

import http from "node:http";
import { URL } from "node:url";
import { jsonRequest, request } from "../util/http.js";

const RECORDS_RE = /^\/api\/database\/records\/([^/?]+)(\/.*)?$/;
const OBJECT_RE = /^\/api\/storage\/buckets\/([^/]+)\/objects\/(.+)$/;
const BUCKETS_RE = /^\/api\/storage\/buckets\/?([^/]*)$/;

function supaHeaders(cfg, extra = {}) {
  return {
    apikey: cfg.supabase.serviceRoleKey,
    authorization: `Bearer ${cfg.supabase.serviceRoleKey}`,
    ...extra,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function startFrontServer(cfg, { logger = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://bridge.local");
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method.toUpperCase();

      // ---- data: /api/database/records/{table} -> /rest/v1/{table} ----
      const records = pathname.match(RECORDS_RE);
      if (records) {
        const table = records[1];
        const upstream = `${cfg.supabase.url.replace(/\/$/, "")}/rest/v1/${table}${url.search}`;
        const body = ["POST", "PATCH", "PUT"].includes(method) ? await readBody(req) : undefined;
        const res2 = await request(method, upstream, {
          headers: supaHeaders(cfg, {
            "content-type": "application/json",
            accept: "application/json",
            ...(body && { "content-length": body.length }),
          }),
          body,
        });
        const text = await res2.text();
        res.writeHead(res2.status, {
          "content-type": res2.headers.get("content-type") || "application/json",
          ...(res2.headers.get("content-range") && { "content-range": res2.headers.get("content-range") }),
        });
        res.end(text);
        return;
      }

      // ---- storage object download ----
      const obj = pathname.match(OBJECT_RE);
      if (obj && method === "GET") {
        const upstream = `${cfg.supabase.url.replace(/\/$/, "")}/storage/v1/object/${obj[1]}/${obj[2]}`;
        const res2 = await request("GET", upstream, { headers: supaHeaders(cfg) });
        res.writeHead(res2.status, { "content-type": res2.headers.get("content-type") || "application/octet-stream" });
        res.end(Buffer.from(await res2.arrayBuffer()));
        return;
      }

      // ---- storage buckets list (admin) ----
      if (BUCKETS_RE.test(pathname) && method === "GET" && !obj) {
        const data = await jsonRequest("GET", `${cfg.supabase.url.replace(/\/$/, "")}/storage/v1/bucket`, {
          headers: supaHeaders(cfg),
        });
        sendJson(res, 200, data);
        return;
      }

      // ---- auth: InsForge session shapes -> Supabase GoTrue ----
      if (pathname === "/api/auth/sessions" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const data = await jsonRequest("POST", `${cfg.supabase.url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
          headers: supaHeaders(cfg, { "content-type": "application/json" }),
          body: { email: body.email, password: body.password },
        });
        sendJson(res, 200, {
          user: { id: data.user?.id, email: data.user?.email },
          session: { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in },
        });
        return;
      }
      if (pathname === "/api/auth/refresh" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const refresh = body.refresh_token || body.refreshToken;
        const data = await jsonRequest("POST", `${cfg.supabase.url.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`, {
          headers: supaHeaders(cfg, { "content-type": "application/json" }),
          body: { refresh_token: refresh },
        });
        sendJson(res, 200, { session: { access_token: data.access_token, refresh_token: data.refresh_token } });
        return;
      }

      sendJson(res, 501, {
        error: "supaforge-bridge front mode: this insforge endpoint is not translated yet",
        hint: "data crud (records), object download, bucket list, and password auth are supported. other endpoints (realtime, functions, model gateway) must move to native supabase at cutover.",
        path: pathname,
      });
    } catch (err) {
      logger(`front error: ${err.message}`);
      sendJson(res, 502, { error: "supaforge-bridge front upstream error", detail: String(err.message) });
    }
  });

  return new Promise((resolve) => {
    server.listen(cfg.bridge.port, cfg.bridge.host, () => {
      resolve({ server, port: server.address().port, host: cfg.bridge.host });
    });
  });
}
