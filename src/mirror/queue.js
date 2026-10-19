// Mirror queue: applies mirror ops to Supabase serially (preserving write
// order) with bounded retries, and parks stubborn failures in the journal
// for `supaforge-bridge replay` once the blocker is fixed.

import { sleep } from "../util/http.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 1500];

export class MirrorQueue {
  constructor(journal, applyFn, { logger = () => {}, onIdle, backoffMs = BACKOFF_MS } = {}) {
    this.journal = journal;
    this.applyFn = applyFn;
    this.logger = logger;
    this.onIdle = onIdle;
    this._queue = [];
    this._draining = false;
    this._seq = 0;
    this._backoffMs = backoffMs;
  }

  enqueue(op) {
    this._seq += 1;
    const rec = this.journal.appendOp({ ...op, seq: this._seq });
    this._queue.push(rec);
    this.logger(`mirror queued #${rec.seq} ${rec.type}`);
    this._drain();
    return rec;
  }

  // Re-feed everything still pending/failed from a previous run.
  resume() {
    const stale = [...this.journal.pending(), ...this.journal.failed()];
    for (const op of stale) this.journal.appendStatus(op.id, "pending");
    for (const op of stale) this._queue.push(this.journal.ops.get(op.id));
    if (stale.length) this.logger(`resumed ${stale.length} unfinished mirror op(s) from journal`);
    this._drain();
    return stale.length;
  }

  pendingCount() {
    return this._queue.length + (this._draining ? 1 : 0);
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._queue.length > 0) {
        const rec = this._queue.shift();
        await this._apply(rec);
      }
    } finally {
      this._draining = false;
      if (this._queue.length > 0) this._drain();
      else if (this.onIdle) this.onIdle();
    }
  }

  async _apply(rec) {
    this.journal.appendStatus(rec.id, "in-flight");
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.applyFn(rec);
        this.journal.appendStatus(rec.id, "done");
        this.logger(`mirror ok #${rec.seq} ${rec.type}`);
        return;
      } catch (err) {
        lastError = err;
        // 4xx (except 429) will not fix themselves on retry — fail fast.
        const status = err && err.status;
        if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) break;
        if (attempt < MAX_ATTEMPTS) await sleep(this._backoffMs[Math.min(attempt - 1, this._backoffMs.length - 1)]);
      }
    }
    this.journal.appendStatus(rec.id, "failed", String(lastError && lastError.message ? lastError.message : lastError));
    this.logger(`mirror FAILED #${rec.seq} ${rec.type}: ${lastError && lastError.message}`);
  }
}
