#!/usr/bin/env node
// supaforge-bridge cli

import fs from "node:fs";
import path from "node:path";
import { loadConfig, writeConfigTemplate, validateConfig, DEFAULT_CONFIG_FILENAME } from "./config.js";
import { Journal } from "./journal.js";
import { startBridge } from "./server/proxy.js";
import { startFrontServer } from "./server/front.js";
import { cutoverCheck, formatCutoverReport } from "./cutover.js";
import { jsonRequest } from "./util/http.js";

function usage() {
  return `
supaforge-bridge — develop on insforge, mirror to supabase, cutover without copy-paste.

usage:
  supaforge-bridge init                    write a supaforge.config.json template
  supaforge-bridge start [--mode mirror|front] [--port N]
                                          start the bridge (default: mirror mode on :7131)
                                          mirror: proxy insforge + mirror writes to supabase
                                          front:   serve insforge-shaped api from supabase
  supaforge-bridge status                 journal stats + failed ops
  supaforge-bridge replay                 retry failed mirror ops
  supaforge-bridge sql --file f.sql | --statement "SQL"
                                          run sql on both insforge and supabase
  supaforge-bridge cutover-check          schema/row-count drift report
  supaforge-bridge cutover                print the cutover checklist + write .env.cutover
  supaforge-bridge selftest               run the built-in test suite (no external services)

env: INSFORGE_URL, INSFORGE_ADMIN_KEY, INSFORGE_SQL_PATH,
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN,
     SUPABASE_PROJECT_REF, SUPAFORGE_PORT
`.trim();
}

function fail(msg) {
  console.error(`supaforge-bridge: ${msg}`);
  process.exit(1);
}

function getJournal(cfg) {
  const journal = new Journal(cfg.bridge.journalPath);
  journal.load();
  return journal;
}

async function cmdStart(args, cfg) {
  const mode = argValue(args, "--mode") || "mirror";
  const portFlag = argValue(args, "--port");
  if (portFlag) cfg.bridge.port = Number(portFlag);

  if (mode === "front") {
    const missing = validateConfig(cfg, ["supabaseData"]);
    if (missing.length) fail(`missing config: ${missing.join(", ")}`);
    const { server, port } = await startFrontServer(cfg, { logger: (m) => console.log(`[front] ${m}`) });
    console.log(`supaforge-bridge (front mode) listening on http://${cfg.bridge.host}:${port}`);
    console.log(`serving insforge-shaped api from ${cfg.supabase.url}`);
    console.log("press ctrl+c to stop.");
    return () => server.close();
  }

  const missing = validateConfig(cfg, ["supabaseData", "supabaseMgmt"]);
  if (missing.length) fail(`missing config: ${missing.join(", ")}\n(hint: set them in supaforge.config.json or env, then re-run)`);

  const journal = getJournal(cfg);
  const { server, queue, port } = await startBridge(cfg, {
    journal,
    logger: (m) => console.log(`[mirror] ${m}`),
  });
  const resumed = queue.resume();
  console.log(`supaforge-bridge (mirror mode) listening on http://${cfg.bridge.host}:${port}`);
  console.log(`forwarding to insforge at ${cfg.insforge.baseUrl}`);
  console.log(`mirroring writes to ${cfg.supabase.url}`);
  console.log(`journal: ${path.resolve(cfg.bridge.journalPath)}`);
  if (resumed > 0) console.log(`resumed ${resumed} unfinished mirror op(s) from a previous run.`);
  console.log("point your insforge cli/mcp/sdk base url here. ctrl+c to stop.");
  return () => server.close();
}

async function cmdStatus(cfg) {
  const journal = getJournal(cfg);
  const stats = journal.stats();
  console.log("supaforge-bridge journal:", JSON.stringify(stats));
  const failed = journal.failed();
  if (failed.length) {
    console.log(`\n${failed.length} failed op(s):`);
    for (const op of failed.slice(0, 20)) {
      console.log(`  #${op.seq} ${op.type} ${op.table || op.bucket || ""}: ${op.error || "unknown error"}`);
    }
    if (failed.length > 20) console.log(`  ... and ${failed.length - 20} more`);
    console.log("\nfix the blocker, then run `supaforge-bridge replay`.");
  }
}

async function cmdReplay(cfg) {
  const journal = getJournal(cfg);
  const { replayJournal } = await import("./replay.js");
  const result = await replayJournal(cfg, journal);
  if (result.total === 0) {
    console.log("nothing to replay — journal is clean.");
    return;
  }
  console.log(`replayed ${result.total} op(s): ${result.ok} ok, ${result.failed.length} failed.`);
  for (const f of result.failed) console.log(`  failed #${f.seq} ${f.type}: ${f.error}`);
}

async function cmdSql(args, cfg) {
  const file = argValue(args, "--file");
  const statement = argValue(args, "--statement");
  if (!file && !statement) fail("sql needs --file <path> or --statement <sql>");
  const sql = file ? fs.readFileSync(path.resolve(file), "utf8") : statement;

  const missing = validateConfig(cfg, ["insforgeKey", "supabaseMgmt"]);
  if (missing.length) fail(`missing config: ${missing.join(", ")}`);

  // insforge first (dev source of truth), then mirror.
  console.log(`[insforge] running ${sql.length} chars of sql...`);
  await jsonRequest("POST", `${cfg.insforge.baseUrl.replace(/\/$/, "")}${cfg.insforge.sqlPath}`, {
    headers: { authorization: `Bearer ${cfg.insforge.adminKey}`, "content-type": "application/json" },
    body: { query: sql, sql },
  });
  console.log("[insforge] ok");

  console.log("[supabase] running same sql via management api...");
  const { applyMirrorOp } = await import("./mirror/apply.js");
  await applyMirrorOp(cfg, { type: "sql", sql });
  console.log("[supabase] ok — both sides in sync.");
}

async function cmdCutoverCheck(cfg) {
  const missing = validateConfig(cfg, ["insforgeKey", "supabaseMgmt"]);
  if (missing.length) fail(`missing config: ${missing.join(", ")}`);
  const journal = getJournal(cfg);
  const pendingCount = journal.pending().length + journal.failed().length;
  let report;
  try {
    report = await cutoverCheck(cfg);
  } catch (err) {
    fail(`cutover check failed: ${err.message}\n(hint: check insforge.sqlPath matches your insforge sql endpoint)`);
  }
  console.log(formatCutoverReport(report, pendingCount));
}

async function cmdCutover(cfg) {
  const env = [
    "# written by supaforge-bridge cutover — values for running against supabase.",
    `SUPABASE_URL=${cfg.supabase.url}`,
    `SUPABASE_ANON_KEY=<your anon key from the supabase dashboard>`,
    `SUPABASE_SERVICE_ROLE_KEY=${cfg.supabase.serviceRoleKey ? "<present in bridge config>" : "<your service role key>"}`,
    "",
    "# if you keep the bridge in front mode, only the base url changes:",
    `INSFORGE_URL=http://${cfg.bridge.host}:${cfg.bridge.port}`,
    "",
  ].join("\n");
  fs.writeFileSync(".env.cutover", env);
  console.log(fs.readFileSync(".env.cutover", "utf8"));
  console.log(`wrote .env.cutover.`);
  console.log(`
cutover checklist:
  1. supaforge-bridge cutover-check   -> resolve any drift
  2. stop the mirror bridge, restart it with: supaforge-bridge start --mode front
     (your app keeps speaking insforge-shaped api, now served by supabase)
  3. or switch the app to native supabase (base url + /rest/v1 paths) whenever ready.
  4. realtime, edge functions and the model gateway are not mirrored — port them manually.
  5. real production users should be migrated with supabase's user migration tooling;
     dev users mirrored by the bridge are best-effort only.
`.trim());
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function argFlag(args, flag) {
  return args.includes(flag);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }
  const configPath = argValue(rest, "--config") || DEFAULT_CONFIG_FILENAME;
  const cfg = loadConfig(fs.existsSync(configPath) ? configPath : undefined);

  switch (cmd) {
    case "init":
      if (fs.existsSync(configPath) && !argFlag(rest, "--force")) {
        fail(`${configPath} already exists (use --force to overwrite)`);
      }
      writeConfigTemplate(configPath);
      console.log(`wrote ${configPath} — fill in your keys, or set the env vars listed in \`supaforge-bridge --help\`.`);
      break;
    case "start": {
      const close = await cmdStart(rest, cfg);
      const shutdown = () => { close(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      break;
    }
    case "status": await cmdStatus(cfg); break;
    case "replay": await cmdReplay(cfg); break;
    case "sql": await cmdSql(rest, cfg); break;
    case "cutover-check": await cmdCutoverCheck(cfg); break;
    case "cutover": await cmdCutover(cfg); break;
    case "selftest": {
      const { spawnSync } = await import("node:child_process");
      const file = new URL("./selftest.js", import.meta.url).pathname;
      const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    default: fail(`unknown command: ${cmd}\n\n${usage()}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
