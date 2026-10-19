// Built-in test suite for supaforge-bridge. Runs against in-process mock
// InsForge and mock Supabase servers — no external services, no deps.
//
//   node src/selftest.js

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { splitSql, extractSqlCandidates } from "./util/sqlsplit.js";
import { classify, mirrorOpFor } from "./server/routes.js";
import { Journal } from "./journal.js";
import { startBridge } from "./server/proxy.js";
import { startFrontServer } from "./server/front.js";
import { cutoverCheck } from "./cutover.js";
import { replayJournal } from "./replay.js";

// ---------------------------------------------------------------- helpers

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function startMock(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function until(cond, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function tmpJournalDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `supaforge-${name}-`));
  return { dir, journalPath: path.join(dir, "journal.ndjson") };
}

function makeCfg(insforge, supabase, journalPath, stateDir) {
  return {
    insforge: { baseUrl: insforge.url, adminKey: "if-admin-key", sqlPath: "/api/database/query" },
    supabase: {
      url: supabase.url,
      serviceRoleKey: "service-role-key",
      mgmtBaseUrl: supabase.url,
      accessToken: "sbp-test-token",
      projectRef: "testref",
    },
    bridge: {
      port: 0,
      host: "127.0.0.1",
      journalPath,
      stateDir: stateDir || path.join(path.dirname(journalPath), "state"),
      maxMirrorBodyBytes: 10 * 1024 * 1024,
    },
  };
}

// ---------------------------------------------------------------- mocks

async function makeInsforgeMock() {
  const state = {
    requests: [],
    objects: new Map(),
    schemaRows: [{ table_name: "posts", column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    countRows: [{ table_name: "posts", approx_rows: 0 }],
    failRest: false,
  };
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://insforge.local");
    const buf = await readBody(req);
    let body = null;
    if (String(req.headers["content-type"] || "").includes("application/json")) {
      try { body = JSON.parse(buf.toString("utf8")); } catch { body = buf.toString("utf8"); }
    } else if (buf.length) {
      body = buf;
    }
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    const p = url.pathname;

    if (p.startsWith("/api/database/records/")) {
      if (state.failRest) return sendJson(res, 500, { error: "mock insforge down" });
      return sendJson(res, req.method === "POST" ? 201 : 200, []);
    }
    if (p === "/api/database/query" && req.method === "POST") {
      const q = String(body.query || body.sql || "");
      if (/pg_stat_user_tables/.test(q)) return sendJson(res, 200, { rows: state.countRows });
      if (/information_schema/.test(q)) return sendJson(res, 200, { rows: state.schemaRows });
      return sendJson(res, 200, { rows: [] });
    }
    const obj = p.match(/^\/api\/storage\/buckets\/([^/]+)\/objects\/(.+)$/);
    if (obj) {
      const key = `${obj[1]}/${obj[2].replace(/\/confirm-upload$/, "")}`;
      if (p.endsWith("/confirm-upload") && req.method === "POST") return sendJson(res, 200, { success: true });
      if (req.method === "PUT") { state.objects.set(key, body); return sendJson(res, 200, { success: true }); }
      if (req.method === "GET") {
        const data = state.objects.get(key);
        if (!data) return sendJson(res, 404, { error: "object not found" });
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(data);
      }
      if (req.method === "DELETE") { state.objects.delete(key); return sendJson(res, 200, { success: true }); }
    }
    if (p === "/api/storage/buckets" && req.method === "GET") {
      return sendJson(res, 200, { buckets: [...new Set([...state.objects.keys()].map((k) => k.split("/")[0]))].map((name) => ({ name })) });
    }
    if (/^\/api\/storage\/buckets\/?([^/]*)$/.test(p) && (req.method === "POST" || req.method === "PUT")) {
      return sendJson(res, 201, { name: body?.name || RegExp.$1 || "bucket" });
    }
    if (p === "/api/auth/users" && req.method === "POST") {
      return sendJson(res, 201, { id: "if-user-1", email: body?.email });
    }
    sendJson(res, 200, { ok: true, path: p });
  };
  const server = await startMock(handler);
  return { state, ...server };
}

async function makeSupabaseMock() {
  const state = {
    requests: [],
    objects: new Map(),
    users: [],
    buckets: [],
    failTables: [],
    restGetRows: [{ id: 1, title: "hello" }],
    schemaRows: [{ table_name: "posts", column_name: "id", data_type: "bigint", is_nullable: "NO" }],
    countRows: [{ table_name: "posts", approx_rows: 0 }],
    failMgmtOnce: false,
  };
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://supabase.local");
    const buf = await readBody(req);
    let body = null;
    if (String(req.headers["content-type"] || "").includes("application/json")) {
      try { body = JSON.parse(buf.toString("utf8")); } catch { body = buf.toString("utf8"); }
    } else if (buf.length) {
      body = buf;
    }
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    const p = url.pathname;

    const rest = p.match(/^\/rest\/v1\/([^/?]+)$/);
    if (rest) {
      const table = rest[1];
      if (state.failTables.includes(table)) return sendJson(res, 500, { error: "mock supabase table missing" });
      if (req.method === "POST") return sendJson(res, 201, body || []);
      if (req.method === "PATCH") return sendJson(res, 200, body || []);
      if (req.method === "DELETE") return sendJson(res, 204, {});
      return sendJson(res, 200, state.restGetRows);
    }
    if (p === "/v1/projects/testref/database/query" && req.method === "POST") {
      if (state.failMgmtOnce) { state.failMgmtOnce = false; return sendJson(res, 500, { error: "mock mgmt blip" }); }
      const q = String(body.query || "");
      if (/pg_stat_user_tables/.test(q)) return sendJson(res, 200, state.countRows);
      if (/information_schema/.test(q)) return sendJson(res, 200, state.schemaRows);
      return sendJson(res, 200, []);
    }
    const up = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (up) {
      if (req.method === "POST") { state.objects.set(`${up[1]}/${up[2]}`, body); return sendJson(res, 200, { Key: `${up[1]}/${up[2]}` }); }
      if (req.method === "DELETE") { state.objects.delete(`${up[1]}/${up[2]}`); return sendJson(res, 200, {}); }
      const data = state.objects.get(`${up[1]}/${up[2]}`);
      if (!data) return sendJson(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(data);
    }
    if (p === "/storage/v1/bucket" && req.method === "POST") {
      state.buckets.push(body);
      return sendJson(res, 200, { name: body?.name });
    }
    if (p === "/storage/v1/bucket" && req.method === "GET") return sendJson(res, 200, state.buckets);
    if (p === "/auth/v1/admin/users" && req.method === "POST") {
      state.users.push(body);
      return sendJson(res, 201, { id: `sb-${state.users.length}`, email: body?.email });
    }
    if (p === "/auth/v1/token" && req.method === "POST") {
      return sendJson(res, 200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, user: { id: "u1", email: body?.email } });
    }
    sendJson(res, 200, { ok: true, path: p });
  };
  const server = await startMock(handler);
  return { state, ...server };
}

function supaRequests(state, method, path) {
  return state.requests.filter((r) => r.method === method && r.path === path);
}

// ---------------------------------------------------------------- units

test("splitSql handles comments, strings, dollar quotes", () => {
  const sql = `-- leading comment
create table public.dogs (
  id bigint primary key,
  note text default '; not a separator'
);
create function public.f() returns void as $$
begin
  insert into x values ('a;b');
end; $$ language plpgsql;
/* block ; comment */
alter table public.dogs add column breed text;
insert into public.dogs (note) values ('won''t split; here');`;
  const stmts = splitSql(sql);
  assert.equal(stmts.length, 4, `got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /create table public\.dogs/);
  assert.match(stmts[1], /\$\$[\s\S]*plpgsql/);
  assert.match(stmts[2], /alter table public\.dogs/);
  assert.match(stmts[3], /won''t split/);
});

test("extractSqlCandidates finds SQL in unknown payload shapes", () => {
  const body = { migration: { name: "0001_init", content: "create table public.a (id int);" }, meta: { whatever: { statements: ["alter table public.a add column b text;"] } }, noise: "hello world" };
  const found = extractSqlCandidates(body);
  assert.equal(found.length, 2);
  assert.match(found[0], /create table/);
  assert.match(found[1], /alter table/);
});

test("classify routes InsForge endpoints", () => {
  const mk = (m, u) => classify({ method: m, url: u });
  assert.equal(mk("POST", "/api/database/records/posts").kind, "data");
  assert.equal(mk("POST", "/api/database/records/posts").table, "posts");
  assert.equal(mk("POST", "/api/database/query").kind, "sql");
  assert.equal(mk("PUT", "/api/storage/buckets/avatars/objects/p.png").kind, "storage-object");
  assert.equal(mk("POST", "/api/storage/buckets/avatars/objects/p.png/confirm-upload").kind, "storage-confirm");
  assert.equal(mk("POST", "/api/storage/buckets/avatars").kind, "storage-bucket");
  assert.equal(mk("POST", "/api/auth/users").kind, "auth-user");
  assert.equal(mk("GET", "/api/model/gateway/whatever").kind, "passthrough");
  const op = mirrorOpFor(mk("PATCH", "/api/database/records/posts?status=eq.draft"), { status: "archived" });
  assert.equal(op.type, "data-update");
  assert.equal(op.query, "?status=eq.draft");
});

// ---------------------------------------------------------------- e2e

test("e2e: data writes pass through to InsForge and mirror to Supabase", async () => {
  const ifMock = await makeInsforgeMock();
  const sbMock = await makeSupabaseMock();
  const { journalPath } = tmpJournalDir("data");
  const cfg = makeCfg(ifMock, sbMock, journalPath);
  const journal = new Journal(cfg.bridge.journalPath);
  journal.load();
  const bridge = await startBridge(cfg, { journal, backoffMs: [1, 1] });

  try {
    // INSERT
    const ins = await fetch(`http://127.0.0.1:${bridge.port}/api/database/records/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anon" },
      body: JSON.stringify([{ id: 1, title: "hello" }]),
    });
    assert.equal(ins.status, 201);
    await until(() => supaRequests(sbMock.state, "POST", "/rest/v1/posts").length >= 1, 5000, "insert mirrored");
    const ifReq = ifMock.state.requests.find((r) => r.method === "POST" && r.path === "/api/database/records/posts");
    assert.ok(ifReq, "InsForge received the passthrough");
    const sbReq = supaRequests(sbMock.state, "POST", "/rest/v1/posts")[0];
    assert.deepEqual(sbReq.body, [{ id: 1, title: "hello" }]);
    assert.equal(sbReq.headers.apikey, "service-role-key");
    assert.equal(sbReq.headers.prefer, "return=minimal");

    // PATCH with filters
    await fetch(`http://127.0.0.1:${bridge.port}/api/database/records/posts?status=eq.draft`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    await until(() => supaRequests(sbMock.state, "PATCH", "/rest/v1/posts").length >= 1, 5000, "patch mirrored");
    const sbPatch = supaRequests(sbMock.state, "PATCH", "/rest/v1/posts")[0];
    assert.equal(sbPatch.query, "?status=eq.draft");
    assert.deepEqual(sbPatch.body, { status: "archived" });

    // DELETE with filters
    await fetch(`http://127.0.0.1:${bridge.port}/api/database/records/posts?id=eq.1`, { method: "DELETE" });
    await until(() => supaRequests(sbMock.state, "DELETE", "/rest/v1/posts").length >= 1, 5000, "delete mirrored");
    assert.equal(supaRequests(sbMock.state, "DELETE", "/rest/v1/posts")[0].query, "?id=eq.1");

    await until(() => journal.done().length === 3, 5000, "all three mirror ops done");
    assert.equal(journal.failed().length, 0);
  } finally {
    bridge.server.close();
    ifMock.server.close();
    sbMock.server.close();
  }
});

test("e2e: migration SQL is captured and applied to Supabase", async () => {
  const ifMock = await makeInsforgeMock();
  const sbMock = await makeSupabaseMock();
  const { journalPath } = tmpJournalDir("mig");
  const cfg = makeCfg(ifMock, sbMock, journalPath);
  const journal = new Journal(cfg.bridge.journalPath);
  journal.load();
  const bridge = await startBridge(cfg, { journal, backoffMs: [1, 1] });

  try {
    const sql = "create table public.dogs (id bigint primary key);\nalter table public.dogs add column breed text;";
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/database/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    assert.equal(res.status, 200);
    await until(() => sbMock.state.requests.some((r) => r.path === "/v1/projects/testref/database/query"), 5000, "mgmt query");
    const mgmt = sbMock.state.requests.filter((r) => r.path === "/v1/projects/testref/database/query");
    assert.ok(mgmt.length >= 1);
    const q = String(mgmt[0].body.query);
    assert.match(q, /set search_path to public/);
    assert.match(q, /create table public\.dogs/);
    assert.match(q, /alter table public\.dogs/);
    assert.equal(mgmt[0].headers.authorization, "Bearer sbp-test-token");
    await until(() => journal.done().length === 1, 5000, "sql op done");
  } finally {
    bridge.server.close();
    ifMock.server.close();
    sbMock.server.close();
  }
});

test("e2e: storage bucket + direct upload + confirm-upload mirror to Supabase", async () => {
  const ifMock = await makeInsforgeMock();
  const sbMock = await makeSupabaseMock();
  const { journalPath } = tmpJournalDir("storage");
  const cfg = makeCfg(ifMock, sbMock, journalPath);
  const journal = new Journal(cfg.bridge.journalPath);
  journal.load();
  const bridge = await startBridge(cfg, { journal, backoffMs: [1, 1] });

  try {
    // bucket create
    await fetch(`http://127.0.0.1:${bridge.port}/api/storage/buckets/avatars`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public: false }),
    });
    await until(() => sbMock.state.buckets.length === 1, 5000, "bucket mirrored");
    assert.equal(sbMock.state.buckets[0].name, "avatars");

    // direct binary upload through the bridge
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    await fetch(`http://127.0.0.1:${bridge.port}/api/storage/buckets/avatars/objects/pic.png`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    await until(() => sbMock.state.objects.has("avatars/pic.png"), 5000, "direct upload mirrored");
    assert.deepEqual(Buffer.from(sbMock.state.objects.get("avatars/pic.png")), bytes);
    assert.ok(ifMock.state.objects.has("avatars/pic.png"), "passthrough stored on InsForge too");

    // presigned-style upload (bypasses bridge) + confirm-upload mirror
    const secret = Buffer.from("this-came-via-s3-presigned");
    ifMock.state.objects.set("avatars/secret.bin", secret);
    await fetch(`http://127.0.0.1:${bridge.port}/api/storage/buckets/avatars/objects/secret.bin/confirm-upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await until(() => sbMock.state.objects.has("avatars/secret.bin"), 5000, "confirm-upload mirrored");
    assert.deepEqual(Buffer.from(sbMock.state.objects.get("avatars/secret.bin")), secret);
  } finally {
    bridge.server.close();
    ifMock.server.close();
    sbMock.server.close();
  }
});

test("e2e: auth user mirror; passwordless user parks as failed op", async () => {
  const ifMock = await makeInsforgeMock();
  const sbMock = await makeSupabaseMock();
  const { journalPath } = tmpJournalDir("auth");
  const cfg = makeCfg(ifMock, sbMock, journalPath);
  const journal = new Journal(cfg.bridge.journalPath);
  journal.load();
  const bridge = await startBridge(cfg, { journal, backoffMs: [1, 1] });

  try {
    await fetch(`http://127.0.0.1:${bridge.port}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", password: "hunter2" }),
    });
    await until(() => sbMock.state.users.length === 1, 5000, "user mirrored");
    assert.equal(sbMock.state.users[0].email, "dev@example.com");
    assert.equal(sbMock.state.users[0].email_confirm, true);

    await fetch(`http://127.0.0.1:${bridge.port}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "oauth@example.com" }), // no password
    });
    await until(() => journal.failed().length === 1, 8000, "passwordless op parked");
    assert.match(journal.failed()[0].error, /no password/);
  } finally {
    bridge.server.close();
    ifMock.server.close();
    sbMock.server.close();
  }
});

test("e2e: failed mirror retries, parks in journal, replays cleanly after fix", async () => {
  const ifMock = await makeInsforgeMock();
  const sbMock = await makeSupabaseMock();
  sbMock.state.failTables = ["posts"]; // e.g. table not created on Supabase yet
  const { journalPath } = tmpJournalDir("retry");
  const cfg = makeCfg(ifMock, sbMock, journalPath);
  const journal = new Journal(cfg.bridge.journalPath);
  journal.load();
  const bridge = await startBridge(cfg, { journal, backoffMs: [1, 1] });

  try {
    await fetch(`http://127.0.0.1:${bridge.port}/api/database/records/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: 9, title: "orphan" }]),
    });
    await until(() => journal.failed().length === 1, 8000, "op failed and parked");
    assert.match(journal.failed()[0].error, /500/);

    // journal survives a restart
    const journal2 = new Journal(cfg.bridge.journalPath);
    journal2.load();
    assert.equal(journal2.failed().length, 1);

    // fix the blocker, replay
    sbMock.state.failTables = [];
    const result = await replayJournal(cfg, journal2);
    assert.equal(result.ok, 1);
    assert.equal(result.failed.length, 0);
    await until(() => supaRequests(sbMock.state, "POST", "/rest/v1/posts").length >= 1, 5000, "replayed insert applied");
    assert.equal(journal2.failed().length, 0);
    assert.equal(journal2.done().length, 1);
  } finally {
    bridge.server.close();
    ifMock.server.close();
    sbMock.server.close();
  }
});

test("cutover-check detects schema drift between the two sides", async () => {
  const ifMock = await makeInsforgeMock();
  const sbMock = await makeSupabaseMock();
  const { journalPath } = tmpJournalDir("cutover");
  const cfg = makeCfg(ifMock, sbMock, journalPath);

  try {
    // in sync
    let report = await cutoverCheck(cfg);
    assert.equal(report.clean, true);

    // InsForge gains a table Supabase doesn't have
    ifMock.state.schemaRows.push({ table_name: "dogs", column_name: "id", data_type: "bigint", is_nullable: "NO" });
    ifMock.state.countRows.push({ table_name: "dogs", approx_rows: 0 });
    report = await cutoverCheck(cfg);
    assert.equal(report.clean, false);
    assert.deepEqual(report.onlyInInsForge, ["dogs"]);
    assert.deepEqual(report.onlyInSupabase, []);

    // row-count drift
    sbMock.state.schemaRows.push({ table_name: "dogs", column_name: "id", data_type: "bigint", is_nullable: "NO" });
    sbMock.state.countRows.push({ table_name: "dogs", approx_rows: 0 });
    sbMock.state.countRows[0].approx_rows = 42;
    ifMock.state.countRows[0].approx_rows = 50;
    report = await cutoverCheck(cfg);
    assert.equal(report.clean, false);
    assert.ok(report.countDiffs.length >= 1);
  } finally {
    ifMock.server.close();
    sbMock.server.close();
  }
});

test("front mode: InsForge-shaped API served from Supabase", async () => {
  const sbMock = await makeSupabaseMock();
  const { journalPath } = tmpJournalDir("front");
  const cfg = makeCfg({ url: "http://unused" }, sbMock, journalPath);
  const front = await startFrontServer(cfg);

  try {
    // data GET passthrough
    const res = await fetch(`http://127.0.0.1:${front.port}/api/database/records/posts?status=eq.published&select=*`, {
      headers: { authorization: "Bearer anon" },
    });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.deepEqual(rows, [{ id: 1, title: "hello" }]);
    const sbGet = sbMock.state.requests.find((r) => r.method === "GET" && r.path === "/rest/v1/posts");
    assert.ok(sbGet, "GET hit Supabase rest");
    assert.equal(sbGet.query, "?status=eq.published&select=*");

    // data POST
    await fetch(`http://127.0.0.1:${front.port}/api/database/records/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: 2, title: "second" }]),
    });
    await until(() => supaRequests(sbMock.state, "POST", "/rest/v1/posts").length === 1, 5000, "front POST hit Supabase");
    assert.deepEqual(supaRequests(sbMock.state, "POST", "/rest/v1/posts")[0].body, [{ id: 2, title: "second" }]);

    // password sign-in translated to GoTrue
    const ses = await fetch(`http://127.0.0.1:${front.port}/api/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", password: "hunter2" }),
    });
    assert.equal(ses.status, 200);
    const session = await ses.json();
    assert.equal(session.session.access_token, "at-1");
    const tokenCall = sbMock.state.requests.find((r) => r.path.startsWith("/auth/v1/token"));
    assert.ok(tokenCall, "token grant called");
    assert.equal(tokenCall.query, "?grant_type=password");

    // unsupported endpoint is explicit
    const miss = await fetch(`http://127.0.0.1:${front.port}/api/model/gateway/v1/chat/completions`, { method: "POST" });
    assert.equal(miss.status, 501);
    const missBody = await miss.json();
    assert.match(missBody.error, /not translated/i);
  } finally {
    front.server.close();
    sbMock.server.close();
  }
});

test("journal stats report queue state", async () => {
  const { journalPath } = tmpJournalDir("stats");
  const journal = new Journal(journalPath);
  const a = journal.appendOp({ type: "data-insert", table: "t", body: [{}] });
  const b = journal.appendOp({ type: "data-insert", table: "t", body: [{}] });
  journal.appendStatus(a.id, "done");
  journal.appendStatus(b.id, "failed", "boom");
  const reloaded = new Journal(journalPath);
  reloaded.load();
  assert.equal(reloaded.done().length, 1);
  assert.equal(reloaded.failed().length, 1);
  assert.equal(reloaded.stats().done, 1);
  assert.equal(reloaded.stats().failed, 1);
});
