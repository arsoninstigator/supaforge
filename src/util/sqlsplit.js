// SQL statement splitter: splits a script on top-level semicolons while
// respecting single/double quotes, dollar-quoted blocks ($$ / $tag$),
// line comments (--) and block comments (/* */).

export function splitSql(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  // state: null | "'" | '"' | "$" (dollar-quoted) | "--" | "/*"
  let quote = null;
  let dollarTag = null;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    if (quote === "--") {
      if (ch === "\n") { current += ch; quote = null; }
      else current += ch;
      i++;
      continue;
    }
    if (quote === "/*") {
      if (ch === "*" && next === "/") { current += "*/"; i += 2; quote = null; }
      else { current += ch; i++; }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        // '' is an escaped quote inside a single-quoted string
        if (next === "'") { current += "''"; i += 2; continue; }
        current += ch; quote = null; i++; continue;
      }
      current += ch; i++; continue;
    }
    if (quote === '"') {
      if (ch === '"') { current += ch; quote = null; i++; continue; }
      current += ch; i++; continue;
    }
    if (quote === "$") {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag; i += dollarTag.length; quote = null; dollarTag = null;
        continue;
      }
      current += ch; i++; continue;
    }

    // not inside a literal / comment
    if (ch === "-" && next === "-") { quote = "--"; current += "--"; i += 2; continue; }
    if (ch === "/" && next === "*") { quote = "/*"; current += "/*"; i += 2; continue; }
    if (ch === "'") { quote = "'"; current += ch; i++; continue; }
    if (ch === '"') { quote = '"'; current += ch; i++; continue; }
    if (ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        quote = "$";
        current += m[0];
        i += m[0].length;
        continue;
      }
      current += ch; i++; continue;
    }
    if (ch === ";") {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

// Heuristic: does this text look like SQL we should mirror (DDL/DML)?
const SQL_LOOKS_LIKE = /\b(create|alter|drop|insert\s+into|update\s+\w+\s+set|delete\s+from|grant|revoke|comment\s+on|create\s+extension|create\s+policy|create\s+function|create\s+trigger|create\s+index|truncate)\b/i;

export function looksLikeSql(text) {
  return typeof text === "string" && SQL_LOOKS_LIKE.test(text);
}

// Recursively find SQL-looking strings inside an unknown JSON body shape.
// InsForge's CLI/MCP migration payloads differ; scanning for likely SQL
// fields lets the bridge capture schema changes without hardcoding shapes.
const PREFERRED_KEYS = /^(sql|query|statement|statements|content|migration|migration_sql|script|body)$/i;

export function extractSqlCandidates(value, out = [], depth = 0) {
  if (depth > 6 || out.length >= 50) return out;
  if (typeof value === "string") {
    if (looksLikeSql(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractSqlCandidates(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && PREFERRED_KEYS.test(k) && looksLikeSql(v)) {
        out.push(v);
        continue;
      }
      extractSqlCandidates(v, out, depth + 1);
    }
  }
  return out;
}
