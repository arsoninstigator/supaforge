// The bridge server: a transparent reverse proxy in front of InsForge.
// Every request is forwarded verbatim; for operations that mutate state
// (data writes, migrations/SQL, storage, auth) a mirror op is captured and
// queued for Supabase. Reads pass through untouched.

import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { classify, mirrorOpFor } from "./routes.js";
import { MirrorQueue } from "../mirror/queue.js";
import { applyMirrorOp } from "../mirror/apply.js";

// Binary bodies (storage uploads) are written to a sidecar file so the
// NDJSON journal stays small; mirror ops reference them via bodyPath.
function stashBinaryBody(cfg, op) {
  const dir = path.join(cfg.bridge.stateDir, "bodies");
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const file = path.join(dir, `${id}.bin`);
  fs.writeFileSync(file, op.body);
  op.id = id;
  op.bodyPath = file;
  delete op.body;
}

export function startBridge(cfg, opts = {}) {
  const { journal, logger = () => {}, onMirrored } = opts;
  const insforgeUrl = new URL(cfg.insforge.baseUrl);
  const queue = new MirrorQueue(journal, (rec) => applyMirrorOp(cfg, rec), {
    logger,
    onIdle: onMirrored,
    backoffMs: opts.backoffMs,
  });

  const server = http.createServer(async (req, res) => {
    const info = classify(req);
    const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(info.method);

    // Buffer the body when we might mirror it (JSON payloads and direct
    // storage uploads), otherwise stream through without buffering.
    const wantsBody =
      isMutation &&
      (info.kind === "data" || info.kind === "sql" || info.kind === "auth-user" ||
        (info.kind === "storage-object" && (info.method === "PUT" || info.method === "POST")) ||
        info.kind === "storage-bucket");
    const cap = wantsBody ? cfg.bridge.maxMirrorBodyBytes : 0;

    const chunks = [];
    let buffered = 0;
    let overflowed = false;

    const upstreamReq = http.request(
      {
        hostname: insforgeUrl.hostname,
        port: insforgeUrl.port || (insforgeUrl.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: insforgeUrl.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "supaforge-bridge: upstream InsForge unreachable", detail: String(err.message) }));
    });

    req.on("data", (chunk) => {
      upstreamReq.write(chunk);
      if (wantsBody && !overflowed) {
        if (buffered + chunk.length > cap) {
          overflowed = true;
          chunks.length = 0;
        } else {
          chunks.push(chunk);
          buffered += chunk.length;
        }
      }
    });
    req.on("end", async () => {
      upstreamReq.end();
      let body = null;
      let contentType = req.headers["content-type"];
      if (wantsBody && !overflowed && chunks.length > 0) {
        const buf = Buffer.concat(chunks);
        if (String(contentType || "").includes("application/json")) {
          try { body = JSON.parse(buf.toString("utf8")); } catch { body = buf.toString("utf8"); }
        } else if (info.kind === "storage-object") {
          body = buf; // raw binary storage upload — stashed to a sidecar file
        } else {
          body = buf.toString("utf8");
        }
      }
      // Mirror decisions are made for every request — bodyless mutations
      // (confirm-upload, deletes) must not be skipped just because we
      // didn't buffer a body.
      const op = mirrorOpFor(info, body);
      if (!op) return;
      if (wantsBody && overflowed) {
        logger(`mirror skipped (body over cap): ${info.method} ${info.pathname}`);
        journal.appendOp({ ...op, seq: 0, status: "skipped-too-large", attempts: 0, error: `body exceeded ${cap} bytes; mirror manually` });
        return;
      }
      if (info.kind === "storage-object") op.contentType = contentType;
      if (Buffer.isBuffer(op.body)) stashBinaryBody(cfg, op);
      queue.enqueue(op);
    });
    req.on("error", () => upstreamReq.destroy());
  });

  return new Promise((resolve) => {
    server.listen(cfg.bridge.port, cfg.bridge.host, () => {
      resolve({ server, queue, port: server.address().port, host: cfg.bridge.host });
    });
  });
}
