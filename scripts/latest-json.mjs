#!/usr/bin/env node
// Writes latest.json, the file installed apps read to find updates.
//   node scripts/latest-json.mjs <assets dir> <version> <owner/repo> <notes file>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, repo, notesFile] = process.argv.slice(2);
if (!dir || !version || !repo) {
  console.error("Usage: node scripts/latest-json.mjs <dir> <version> <owner/repo> [notes file]");
  process.exit(1);
}
const base = `https://github.com/${repo}/releases/download/v${version}`;
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";

// platform key -> file the updater downloads (its .sig sits next to it)
const targets = {
  "windows-x86_64": "APEX-Setup.exe",
  "darwin-aarch64": "APEX-mac-arm64.app.tar.gz",
};

const platforms = {};
for (const [key, file] of Object.entries(targets)) {
  const sig = join(dir, `${file}.sig`);
  if (!existsSync(join(dir, file)) || !existsSync(sig)) {
    console.error(`Missing ${file} or its .sig in ${dir}`);
    process.exit(1);
  }
  platforms[key] = { signature: readFileSync(sig, "utf8").trim(), url: `${base}/${file}` };
}

const out = { version, notes, pub_date: new Date().toISOString(), platforms };
writeFileSync(join(dir, "latest.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`latest.json for ${version}: ${Object.keys(platforms).join(", ")}`);
