#!/usr/bin/env node
// publish preflight for supaforge. dependency-free, runs on any node>=18.
// proves the package is installable before you run npm publish:
//   1. node version, engine fields, bin target, shebang
//   2. npm pack -> a real tarball in a temp dir
//   3. install -g that tarball into a temp prefix with a temp HOME
//   4. run the installed `supaforge` binary: --version and status must answer
//   5. npm auth check (whoami) and registry name check
//
// usage: npm run preflight

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let failed = 0;
const ok = (msg) => console.log(`ok   ${msg}`);
const bad = (msg) => { failed++; console.log(`fail ${msg}`); };
const warn = (msg) => console.log(`warn ${msg}`);

console.log(`supaforge preflight: ${pkg.name}@${pkg.version}\n`);

// 1. static checks
const major = Number(process.versions.node.split(".")[0]);
if (major >= 18) ok(`node ${process.versions.node}`);
else bad(`node ${process.versions.node} (need >=18)`);

if (pkg.engines && pkg.engines.node) ok(`engines.node = ${pkg.engines.node}`);
else bad("package.json has no engines.node");

const binName = Object.keys(pkg.bin || {})[0];
const binTarget = binName ? pkg.bin[binName] : null;
if (!binName || !binTarget) {
  bad("package.json has no bin entry");
} else {
  ok(`bin ${binName} -> ${binTarget}`);
  const binPath = path.join(root, binTarget);
  if (!fs.existsSync(binPath)) bad(`bin target missing: ${binTarget}`);
  else {
    const head = fs.readFileSync(binPath, "utf8").split("\n")[0];
    if (head.startsWith("#!")) ok("bin target has a shebang");
    else bad("bin target has no shebang");
  }
}

for (const f of pkg.files || []) {
  if (fs.existsSync(path.join(root, f.replace(/\/$/, "")))) ok(`files entry exists: ${f}`);
  else bad(`files entry missing: ${f}`);
}

// 2. pack a real tarball
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supaforge-preflight-"));
let tarball = null;
try {
  const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: root, encoding: "utf8" }).trim();
  tarball = path.join(tmp, out.split("\n").pop().trim());
  if (fs.existsSync(tarball)) ok(`packed ${path.basename(tarball)} (${(fs.statSync(tarball).size / 1024).toFixed(0)} kB)`);
  else bad("npm pack produced no tarball");
} catch (err) {
  bad(`npm pack failed: ${err.message}`);
}

// 3+4. install into a temp prefix and run it
if (tarball) {
  const prefix = path.join(tmp, "prefix");
  const home = path.join(tmp, "home");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, npm_config_prefix: prefix };
  try {
    execFileSync("npm", ["install", "-g", tarball, "--silent"], { cwd: tmp, env, encoding: "utf8" });
    ok("installed the tarball into a temp prefix");
    const bin = path.join(prefix, "bin", binName);
    if (!fs.existsSync(bin)) {
      bad(`installed binary missing: ${bin}`);
    } else {
      const version = execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim();
      if (version === pkg.version) ok(`installed \`${binName} --version\` -> ${version}`);
      else bad(`\`${binName} --version\` -> ${version || "(empty)"}, expected ${pkg.version}`);
      const help = execFileSync(bin, ["--help"], { env, encoding: "utf8" });
      if (help.includes(`${binName} start`)) ok(`installed \`${binName} --help\` shows the commands`);
      else bad(`\`${binName} --help\` output looks wrong`);
      const status = execFileSync(bin, ["status"], { env, encoding: "utf8" });
      if (status.includes("journal")) ok(`installed \`${binName} status\` answers`);
      else bad(`\`${binName} status\` output looks wrong`);
    }
  } catch (err) {
    bad(`install/run failed: ${err.message}`);
  }
}

// 5. registry + auth
try {
  const who = execFileSync("npm", ["whoami"], { cwd: root, encoding: "utf8" }).trim();
  ok(`npm authenticated as ${who}`);
} catch {
  warn("npm is not authenticated (npm login before publishing)");
}

// npm unpublish policy: a fully unpublished package blocks new publishes for
// 24 hours, after which the NAME is reusable. used version numbers are spent
// forever ("once package@version has been used, you can never use it again").
try {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}`);
  if (res.status === 404) {
    ok(`name "${pkg.name}" is unclaimed on the registry`);
  } else if (res.status === 200) {
    const doc = await res.json();
    const liveVersions = Object.keys(doc.versions || {});
    const time = doc.time || {};
    const burned = Object.keys(time).filter((k) => /^\d+\.\d+\.\d+/.test(k));
    const unpublished = time.unpublished;

    if (unpublished && liveVersions.length === 0) {
      const hours = (Date.now() - Date.parse(unpublished.time)) / 36e5;
      if (hours >= 24) {
        ok(`name "${pkg.name}" is reusable (fully unpublished ${hours.toFixed(0)}h ago, past npm's 24h cooldown)`);
      } else {
        bad(`name "${pkg.name}" was unpublished ${hours.toFixed(1)}h ago; npm requires 24h before republishing`);
      }
      if (burned.length) {
        warn(`spent version numbers (never reusable): ${burned.join(", ")}`);
        if (burned.includes(pkg.version)) {
          bad(`version ${pkg.version} was already used by the old package; bump to a fresh version`);
        } else {
          ok(`version ${pkg.version} has never been used, so it is free to publish`);
        }
      }
    } else if (doc["dist-tags"] && doc["dist-tags"].latest) {
      const latest = doc["dist-tags"].latest;
      if (liveVersions.includes(pkg.version)) {
        bad(`version ${pkg.version} already exists on the registry; bump the version`);
      } else {
        warn(`name "${pkg.name}" is live (latest ${latest}); this publish adds ${pkg.version}`);
      }
    } else {
      warn(`name "${pkg.name}" exists in an odd state; check before publishing`);
    }
  } else {
    warn(`registry answered ${res.status} for "${pkg.name}"`);
  }
} catch (err) {
  warn(`could not reach the registry: ${err.message}`);
}

console.log("");
if (failed === 0) {
  console.log("preflight clean: the package installs and runs. publish with `npm publish`.");
} else {
  console.log(`${failed} check(s) failed.`);
  process.exit(1);
}
