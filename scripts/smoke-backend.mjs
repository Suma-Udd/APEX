#!/usr/bin/env node
// Starts the backend, checks it answers, then stops it.
//   node scripts/smoke-backend.mjs            -> the built sidecar in src-tauri/binaries
//   node scripts/smoke-backend.mjs --source   -> backend/main.py with the current python
//   node scripts/smoke-backend.mjs --bin path -> a specific backend binary (e.g. the one inside APEX.app)
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromSource = process.argv.includes("--source");
const port = 18000 + Math.floor(Math.random() * 2000);
const token = "smoke-test";
const data = mkdtempSync(join(tmpdir(), "apex-smoke-"));

let cmd, args, cwd = root;
if (fromSource) {
  cmd = process.platform === "win32" ? "python" : "python3";
  args = ["main.py", "--port", String(port)];
  cwd = join(root, "backend");
} else if (process.argv.includes("--bin")) {
  cmd = resolve(process.argv[process.argv.indexOf("--bin") + 1]);
  args = ["--port", String(port)];
} else {
  const dir = join(root, "src-tauri", "binaries");
  const bin = readdirSync(dir).find((f) => f.startsWith("apex-backend-"));
  if (!bin) { console.error("No sidecar in src-tauri/binaries. Run: npm run backend"); process.exit(1); }
  cmd = join(dir, bin);
  args = ["--port", String(port)];
}

// Stand-in for the APEX window: the backend must exit on its own once this is gone.
const fakeParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
args.push("--parent-pid", String(fakeParent.pid));

const child = spawn(cmd, args, { cwd, env: { ...process.env, APEX_TOKEN: token, APEX_DATA: data }, stdio: "inherit" });
let failed = false;
child.on("exit", (code) => { if (!done) { console.error(`Backend exited early with code ${code}`); failed = true; } });
let done = false;

async function get(path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "X-APEX-Token": token } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

try {
  const until = Date.now() + 90_000; // onefile binaries unpack first, Defender can be slow
  let health = null;
  while (!health && !failed && Date.now() < until) {
    try { health = await get("/api/health"); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!health) throw new Error("Backend never answered /api/health");
  const state = await get("/api/paper/state");
  const session = await get("/api/market/session?symbol=EURUSD");
  if (typeof state.equity !== "number") throw new Error("paper state has no equity");
  if (typeof session.open !== "boolean") throw new Error("market session check failed (timezone data missing?)");
  await get("/api/strategies");
  console.log(`Backend OK: equity ${state.equity}, EURUSD ${session.open ? "open" : "closed"}, strategies load`);

  // Orphan check: kill the fake parent, the backend (and on one-file builds its launcher) must quit.
  done = true;
  const exited = new Promise((r) => child.once("exit", () => r(true)));
  fakeParent.kill();
  const quit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 15000))]);
  if (!quit) throw new Error("Backend kept running after the app went away (orphaned process)");
  console.log("Backend exits by itself when the app is gone");
} catch (error) {
  console.error(`Smoke test failed: ${error.message}`);
  failed = true;
} finally {
  done = true;
  child.kill();
  fakeParent.kill();
  setTimeout(() => { try { rmSync(data, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); }, 1500);
}
