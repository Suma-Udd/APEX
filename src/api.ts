import { invoke } from "@tauri-apps/api/core";

type BackendInfo = { port: number; token: string };
let backendInfo: BackendInfo | null = null;

async function getBackendInfo(): Promise<BackendInfo> {
  if (backendInfo) return backendInfo;
  const inTauri = "__TAURI_INTERNALS__" in window;
  if (!inTauri) return (backendInfo = { port: 8765, token: "dev" });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const [port, token] = await invoke<[number, string]>("backend_info");
      return (backendInfo = { port, token });
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  throw new Error("The local backend did not start. Check the APEX logs folder (macOS: ~/Library/Application Support/APEX/logs, Windows: %APPDATA%\\APEX\\logs).");
}

let backendSeen = false;

// The Python sidecar can take a few seconds to unpack on first launch (longer on
// Windows while Defender scans it), so retry connection errors until it answers once.
async function fetchWithStartupRetry(url: string, init: RequestInit): Promise<Response> {
  const attempts = backendSeen ? 1 : 40;
  for (let i = 0; ; i++) {
    try {
      const response = await fetch(url, init);
      backendSeen = true;
      return response;
    } catch (error) {
      if (i >= attempts - 1) throw new Error("Can't reach the local backend");
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { port, token } = await getBackendInfo();
  const response = await fetchWithStartupRetry(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-APEX-Token": token,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch { /* response was not JSON */ }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}
