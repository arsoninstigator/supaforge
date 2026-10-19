// Replay: re-run failed/pending journal ops against Supabase, sequentially.

import { applyMirrorOp } from "./mirror/apply.js";

export async function replayJournal(cfg, journal) {
  const targets = [...journal.pending(), ...journal.failed()];
  if (targets.length === 0) return { total: 0, ok: 0, failed: [] };
  for (const op of targets) journal.appendStatus(op.id, "pending");
  let ok = 0;
  const failed = [];
  for (const op of targets) {
    journal.appendStatus(op.id, "in-flight");
    try {
      await applyMirrorOp(cfg, op);
      journal.appendStatus(op.id, "done");
      ok++;
    } catch (err) {
      journal.appendStatus(op.id, "failed", String(err.message || err));
      failed.push({ seq: op.seq, type: op.type, error: String(err.message || err) });
    }
  }
  return { total: targets.length, ok, failed };
}
