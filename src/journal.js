// Append-only NDJSON journal of mirror operations.
// Lines are either {type:"op", ...} (an operation enqueued) or
// {type:"status", id, status, error} (a status transition).
// Folding the file on load gives the current state of every op.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class Journal {
  constructor(filePath) {
    this.filePath = filePath;
    this.ops = new Map(); // id -> op record (with .status)
    this.order = [];
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (rec.evt === "op") {
        const op = { ...rec };
        delete op.evt;
        this.ops.set(op.id, op);
        this.order.push(op.id);
      } else if (rec.evt === "status") {
        const op = this.ops.get(rec.id);
        if (op) {
          op.status = rec.status;
          op.error = rec.error || op.error;
          op.finishedAt = rec.ts;
        }
      }
    }
  }

  appendOp(op) {
    const rec = { evt: "op", id: op.id || randomUUID(), ts: new Date().toISOString(), status: "pending", attempts: 0, ...op };
    this._writeLine(rec);
    const stored = { ...rec };
    delete stored.evt;
    this.ops.set(stored.id, stored);
    this.order.push(stored.id);
    return stored;
  }

  appendStatus(id, status, error) {
    this._writeLine({ evt: "status", id, status, error, ts: new Date().toISOString() });
    const op = this.ops.get(id);
    if (op) {
      op.status = status;
      if (error) op.error = error;
    }
  }

  _writeLine(rec) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(rec) + "\n");
  }

  pending() { return this.order.map((id) => this.ops.get(id)).filter((o) => o.status === "pending" || o.status === "in-flight"); }
  failed() { return this.order.map((id) => this.ops.get(id)).filter((o) => o.status === "failed"); }
  done() { return this.order.map((id) => this.ops.get(id)).filter((o) => o.status === "done"); }
  stats() {
    const counts = {};
    for (const id of this.order) {
      const s = this.ops.get(id).status;
      counts[s] = (counts[s] || 0) + 1;
    }
    return counts;
  }
  // Reset failed ops to pending (used by `replay`).
  resetFailed() {
    const revived = [];
    for (const op of this.failed()) {
      this.appendStatus(op.id, "pending");
      revived.push(op.id);
    }
    return revived;
  }
}
