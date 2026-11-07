#!/usr/bin/env node
// Runs the Python backend straight from source on port 8765 for `npm run dev` (browser mode).
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const venv = join(root, ".venv-backend");
const venvPy = isWin ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");

if (!existsSync(venvPy)) {
  const py = isWin ? ["py", "-3"] : ["python3"];
  console.log("Creating Python virtual environment…");
  const r = spawnSync(py[0], [...py.slice(1), "-m", "venv", venv], { stdio: "inherit", shell: isWin });
  if (r.status !== 0) { console.error("Python 3.10+ is required: https://www.python.org"); process.exit(1); }
  spawnSync(venvPy, ["-m", "pip", "install", "-r", join(root, "backend", "requirements.txt")], { stdio: "inherit" });
}
console.log("APEX backend on http://127.0.0.1:8765 (Ctrl+C to stop)");
const child = spawn(venvPy, [join(root, "backend", "main.py"), "--port", "8765"], { cwd: join(root, "backend"), stdio: "inherit", env: { ...process.env, APEX_TOKEN: "dev" } });
child.on("exit", (code) => process.exit(code ?? 0));
