// cutover-check: compare InsForge (via its raw-SQL endpoint) and Supabase
// (via the Management API) on schema and approximate row counts, and report
// drift that must be fixed before flipping the app over.

import { jsonRequest } from "./util/http.js";

async function insforgeSql(cfg, query) {
  const url = `${cfg.insforge.baseUrl.replace(/\/$/, "")}${cfg.insforge.sqlPath}`;
  const res = await jsonRequest("POST", url, {
    headers: { authorization: `Bearer ${cfg.insforge.adminKey}`, "content-type": "application/json" },
    body: { query, sql: query },
  });
  // Accept either [{...rows}], {rows:[...]}, or {data:[...]}.
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.rows)) return res.rows;
  if (res && Array.isArray(res.data)) return res.data;
  throw new Error(`unexpected InsForge SQL response shape from ${url}`);
}

async function supabaseSql(cfg, query) {
  const url = `${cfg.supabase.mgmtBaseUrl.replace(/\/$/, "")}/v1/projects/${cfg.supabase.projectRef}/database/query`;
  const res = await jsonRequest("POST", url, {
    headers: { authorization: `Bearer ${cfg.supabase.accessToken}`, "content-type": "application/json" },
    body: { query },
  });
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.rows)) return res.rows;
  if (res && Array.isArray(res.data)) return res.data;
  throw new Error("unexpected Supabase Management API response shape");
}

const SCHEMA_SQL = `select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position, column_name`;

const COUNT_SQL = `select relname as table_name, n_live_tup as approx_rows
from pg_stat_user_tables
where schemaname = 'public'
order by relname`;

export async function cutoverCheck(cfg) {
  const [insforgeCols, supabaseCols, insforgeCounts, supabaseCounts] = await Promise.all([
    insforgeSql(cfg, SCHEMA_SQL),
    supabaseSql(cfg, SCHEMA_SQL),
    insforgeSql(cfg, COUNT_SQL),
    supabaseSql(cfg, COUNT_SQL),
  ]);

  const ifTables = index(insforgeCols);
  const sbTables = index(supabaseCols);

  const onlyInInsForge = [...ifTables.keys()].filter((t) => !sbTables.has(t));
  const onlyInSupabase = [...sbTables.keys()].filter((t) => !ifTables.has(t));
  const columnDiffs = [];
  for (const [table, cols] of ifTables) {
    const other = sbTables.get(table);
    if (!other) continue;
    for (const [col, def] of cols) {
      const oDef = other.get(col);
      if (!oDef) columnDiffs.push(`${table}.${col}: exists in InsForge only`);
      else if (oDef.data_type !== def.data_type) {
        columnDiffs.push(`${table}.${col}: type ${def.data_type} (InsForge) vs ${oDef.data_type} (Supabase)`);
      }
    }
    for (const [col] of other) if (!cols.has(col)) columnDiffs.push(`${table}.${col}: exists in Supabase only`);
  }

  const ifCounts = new Map(insforgeCounts.map((r) => [r.table_name, Number(r.approx_rows)]));
  const sbCounts = new Map(supabaseCounts.map((r) => [r.table_name, Number(r.approx_rows)]));
  const countDiffs = [];
  for (const [t, n] of ifCounts) {
    const m = sbCounts.get(t);
    if (m === undefined) continue;
    if (Math.abs((m || 0) - n) > 5) countDiffs.push(`${t}: ~${n} rows in InsForge vs ~${m} in Supabase`);
  }

  const clean = onlyInInsForge.length === 0 && columnDiffs.length === 0 && countDiffs.length === 0;

  return {
    clean,
    insforgeTables: [...ifTables.keys()].sort(),
    supabaseTables: [...sbTables.keys()].sort(),
    onlyInInsForge,
    onlyInSupabase,
    columnDiffs,
    countDiffs,
  };
}

function index(rows) {
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, new Map());
    tables.get(r.table_name).set(r.column_name, { data_type: r.data_type, is_nullable: r.is_nullable });
  }
  return tables;
}

export function formatCutoverReport(report, pendingCount) {
  const lines = [];
  lines.push("supaforge-bridge :: cutover check");
  lines.push("=".repeat(40));
  lines.push(`insforge tables (${report.insforgeTables.length}): ${report.insforgeTables.join(", ") || "(none)"}`);
  lines.push(`supabase tables (${report.supabaseTables.length}): ${report.supabaseTables.join(", ") || "(none)"}`);
  if (report.onlyInInsForge.length) lines.push(`\n[missing in supabase] ${report.onlyInInsForge.join(", ")} — run migrations or \`supaforge-bridge sql\` to sync them.`);
  if (report.onlyInSupabase.length) lines.push(`[extra in supabase] ${report.onlyInSupabase.join(", ")} — supabase has tables insforge doesn't; confirm they're intentional.`);
  for (const d of report.columnDiffs) lines.push(`[column] ${d}`);
  for (const d of report.countDiffs) lines.push(`[rows] ${d} (approx counts; pending mirror ops may explain this)`);
  if (pendingCount > 0) lines.push(`\n[queue] ${pendingCount} mirror op(s) not yet applied — wait or run \`supaforge-bridge replay\`.`);
  lines.push("");
  lines.push(report.clean && pendingCount === 0
    ? "ok — insforge and supabase look in sync. safe to cutover."
    : "not clean — resolve the items above before flipping the app to supabase.");
  return lines.join("\n");
}
