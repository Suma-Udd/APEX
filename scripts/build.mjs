#!/usr/bin/env node
// One build script for macOS and Windows (and Linux).
//   node scripts/build.mjs              -> full desktop app into release/
//   node scripts/build.mjs --backend    -> only the Python sidecar
//   node scripts/build.mjs --no-dmg     -> macOS: skip the DMG (avoids hdiutil "Resource busy")
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const npm = isWin ? "npm.cmd" : "npm";
const npx = isWin ? "npx.cmd" : "npx";

function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n> ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: isWin, ...opts });
  if (r.status !== 0) { console.error(`\nFailed: ${cmd} ${cmdArgs.join(" ")}`); process.exit(r.status ?? 1); }
}

function findPython() {
  for (const [cmd, pre] of isWin ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]]) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print(sys.version_info >= (3, 10))"], { encoding: "utf8", shell: isWin });
    if (r.status === 0 && r.stdout.trim() === "True") return [cmd, pre];
  }
  console.error("Python 3.10+ not found. Install it from https://www.python.org (on Windows tick 'Add python.exe to PATH').");
  process.exit(1);
}

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/host:\s*(\S+)/);
  if (!m) { console.error("Could not read the Rust host target. Is Rust installed? https://rustup.rs"); process.exit(1); }
  return m[1];
}

const major = Number(process.versions.node.split(".")[0]);
if (![20, 22, 24].includes(major)) {
  console.error(`APEX needs Node 20, 22 or 24 (22 recommended). You have ${process.version}.`);
  process.exit(1);
}

function buildBackend() {
  const [py, pre] = findPython();
  const venv = join(root, ".venv-backend");
  const venvPy = isWin ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  if (!existsSync(venvPy)) {
    // A venv copied over from another OS (e.g. a Mac one on Windows) is useless, start clean.
    if (existsSync(venv)) rmSync(venv, { recursive: true, force: true });
    run(py, [...pre, "-m", "venv", venv]);
  }
  run(venvPy, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(venvPy, ["-m", "pip", "install", "-r", join("backend", "requirements.txt")]);
  const triple = hostTriple();
  const binDir = join(root, "src-tauri", "binaries");
  mkdirSync(binDir, { recursive: true });
  run(venvPy, ["-m", "PyInstaller", "--clean", "--noconfirm", "--onefile", ...(isWin ? ["--noconsole"] : []), "--name", "apex-backend",
    "--hidden-import", "modules.strategy_library", "--hidden-import", "modules.paper_engine", "--hidden-import", "modules.market_data",
    "--hidden-import", "modules.instruments", "--hidden-import", "modules.signals", "--hidden-import", "modules.backtest",
    // Windows has no system timezone database; bundle it so market hours work everywhere.
    "--collect-data", "tzdata", "--hidden-import", "tzdata",
    "--distpath", binDir, "--workpath", ".pyi-build", "--specpath", ".pyi-build", join("backend", "main.py")]);
  const ext = isWin ? ".exe" : "";
  renameSync(join(binDir, `apex-backend${ext}`), join(binDir, `apex-backend-${triple}${ext}`));
  console.log(`\nBackend ready: src-tauri/binaries/apex-backend-${triple}${ext}`);
}

if (!existsSync(join(root, "node_modules"))) run(npm, ["install"]);
buildBackend();
if (args.has("--backend")) process.exit(0);

run(npm, ["run", "build"]);
// Icons live in src-tauri/icons. After changing app-icon.png run: npm run icons
const bundles = isMac ? (args.has("--no-dmg") ? "app" : "app,dmg") : isWin ? "nsis,msi" : "deb,appimage";
run(npx, ["tauri", "build", "--bundles", bundles]);

const out = join(root, "src-tauri", "target", "release", "bundle");
const release = join(root, "release");
mkdirSync(release, { recursive: true });
for (const dir of readdirSync(out)) {
  for (const file of readdirSync(join(out, dir))) {
    if (/\.(app|dmg|exe|msi|deb|AppImage)$/.test(file)) {
      cpSync(join(out, dir, file), join(release, file), { recursive: true });
      console.log(`  release/${file}`);
    }
  }
}
console.log("\nDone. Your installer / app is in the release/ folder.");
