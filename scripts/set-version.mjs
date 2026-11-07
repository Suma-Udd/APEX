#!/usr/bin/env node
// Sets the app version everywhere it lives.
//   node scripts/set-version.mjs 0.3.0
//   node scripts/set-version.mjs 0.3.0 --repo owner/name   (also points the updater at that repo)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [version, ...rest] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node scripts/set-version.mjs 1.2.3 [--repo owner/name]");
  process.exit(1);
}
const repoIdx = rest.indexOf("--repo");
const repo = repoIdx >= 0 ? rest[repoIdx + 1] : null;

function editJson(file, fn) {
  const path = join(root, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  fn(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ${file}`);
}

editJson("package.json", (p) => { p.version = version; });
editJson("package-lock.json", (p) => { p.version = version; if (p.packages?.[""]) p.packages[""].version = version; });
editJson("src-tauri/tauri.conf.json", (c) => {
  c.version = version;
  if (repo) c.plugins.updater.endpoints = [`https://github.com/${repo}/releases/latest/download/latest.json`];
});

const cargo = join(root, "src-tauri", "Cargo.toml");
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`));
console.log("  src-tauri/Cargo.toml");
const lock = join(root, "src-tauri", "Cargo.lock");
if (existsSync(lock)) {
  writeFileSync(lock, readFileSync(lock, "utf8").replace(/(\[\[package\]\]\nname = "apex"\nversion = )".*"/, `$1"${version}"`));
  console.log("  src-tauri/Cargo.lock");
}
console.log(`Version set to ${version}${repo ? `, updates from ${repo}` : ""}`);
