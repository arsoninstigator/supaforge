// Configuration: defaults < supaforge.config.json < environment variables.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG_FILENAME = "supaforge.config.json";

export function defaultConfig() {
  return {
    insforge: {
      // Where InsForge actually runs. Point your CLI/MCP/SDK at the bridge, not here.
      baseUrl: process.env.INSFORGE_URL || "http://localhost:7130",
      adminKey: process.env.INSFORGE_ADMIN_KEY || process.env.INSFORGE_ACCESS_API_KEY || "",
      // InsForge endpoint that executes raw SQL (used by `db query`).
      // Configurable because the self-hosted and cloud paths may differ.
      sqlPath: process.env.INSFORGE_SQL_PATH || "/api/database/query",
    },
    supabase: {
      url: process.env.SUPABASE_URL || "",
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      // Management API (https://api.supabase.com by default) — used to run
      // mirrored DDL. Needs a personal access token (sbp_...) + project ref.
      mgmtBaseUrl: process.env.SUPABASE_MGMT_BASE_URL || "https://api.supabase.com",
      accessToken: process.env.SUPABASE_ACCESS_TOKEN || "",
      projectRef: process.env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_ID || "",
    },
    bridge: {
      port: Number(process.env.SUPAFORGE_PORT || 7131),
      host: process.env.SUPAFORGE_HOST || "127.0.0.1",
      journalPath: process.env.SUPAFORGE_JOURNAL || ".supaforge/journal.ndjson",
      stateDir: process.env.SUPAFORGE_STATE_DIR || ".supaforge",
      // Bodies larger than this are proxied but not mirrored (logged instead).
      maxMirrorBodyBytes: Number(process.env.SUPAFORGE_MAX_BODY_BYTES || 50 * 1024 * 1024),
    },
  };
}

export function loadConfig(configPath) {
  const cfg = defaultConfig();
  if (configPath && fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    deepMerge(cfg, raw);
  }
  return cfg;
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

export function writeConfigTemplate(configPath) {
  const template = {
    $comment: "supaforge-bridge config. Env vars (INSFORGE_URL, SUPABASE_URL, ...) override these values.",
    insforge: {
      baseUrl: "http://localhost:7130",
      adminKey: "your-insforge-admin-or-access-key",
      sqlPath: "/api/database/query",
    },
    supabase: {
      url: "https://yourproject.supabase.co",
      serviceRoleKey: "your-service-role-key",
      mgmtBaseUrl: "https://api.supabase.com",
      accessToken: "sbp_personal_access_token",
      projectRef: "yourprojectref",
    },
    bridge: {
      port: 7131,
      journalPath: ".supaforge/journal.ndjson",
      maxMirrorBodyBytes: 52428800,
    },
  };
  delete template.$comment;
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n");
  return configPath;
}

// Validate that a config has what a given command needs.
export function validateConfig(cfg, needs = []) {
  const missing = [];
  if (needs.includes("insforgeKey") && !cfg.insforge.adminKey) missing.push("insforge.adminKey (INSFORGE_ADMIN_KEY)");
  if (needs.includes("supabaseData") && !cfg.supabase.url) missing.push("supabase.url (SUPABASE_URL)");
  if (needs.includes("supabaseData") && !cfg.supabase.serviceRoleKey) missing.push("supabase.serviceRoleKey (SUPABASE_SERVICE_ROLE_KEY)");
  if (needs.includes("supabaseMgmt") && !cfg.supabase.accessToken) missing.push("supabase.accessToken (SUPABASE_ACCESS_TOKEN)");
  if (needs.includes("supabaseMgmt") && !cfg.supabase.projectRef) missing.push("supabase.projectRef (SUPABASE_PROJECT_REF)");
  return missing;
}
