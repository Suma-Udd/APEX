import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

type Reply = { status: number; body: string };

/**
 * Calls the local backend. In the app every call goes through the Rust shell
 * (no HTTP from the webview, so macOS WebKit can't block it). In a plain browser
 * (`npm run dev` + `npm run dev:backend`) it talks to the dev backend directly.
 */
export async function api<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
  const method = init?.method ?? "GET";
  let reply: Reply;
  if (inDesktopApp) {
    reply = await invoke<Reply>("api", { method, path, body: init?.body ?? null });
  } else {
    const r = await fetch(`http://127.0.0.1:8765${path}`, {
      method, body: init?.body, headers: { "Content-Type": "application/json", "X-APEX-Token": "dev" },
    }).catch(() => { throw new Error("Can't reach the trading engine"); });
    reply = { status: r.status, body: await r.text() };
  }
  let data: unknown = null;
  try { data = reply.body ? JSON.parse(reply.body) : null; } catch { /* not JSON */ }
  if (reply.status < 200 || reply.status >= 300) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === "string" ? detail : `Request failed (${reply.status})`);
  }
  return data as T;
}

export type BackendPhase = "starting" | "ready" | "failed";
export type BackendStatus = { phase: BackendPhase; message: string; log: string[]; data_dir: string };

/** Startup state of the backend process, straight from the Rust shell. */
export function useBackendStatus(): [BackendStatus, () => void] {
  const [status, setStatus] = useState<BackendStatus>({ phase: inDesktopApp ? "starting" : "ready", message: "", log: [], data_dir: "" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!inDesktopApp) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await invoke<BackendStatus>("backend_status");
        if (!alive) return;
        setStatus(s);
        // Fast while starting, slow once it's up (it can still crash later).
        timer = window.setTimeout(tick, s.phase === "starting" ? 250 : 3000);
      } catch {
        if (alive) timer = window.setTimeout(tick, 500);
      }
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [nonce]);
  const restart = () => {
    setStatus((s) => ({ ...s, phase: "starting", message: "", log: [] }));
    void invoke("restart_backend").finally(() => setNonce((n) => n + 1));
  };
  return [status, restart];
}

/**
 * Runs `fn` now and every `ms` while the window is visible. Hidden or minimised
 * windows stop polling (saves battery on a MacBook), and catch up on return.
 */
export function usePoll(fn: () => void | Promise<void>, ms: number, deps: unknown[], enabled = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    let stopped = false;
    const loop = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try { await saved.current(); } catch { /* callers handle their own errors */ }
      }
      if (!stopped) timer = window.setTimeout(loop, ms);
    };
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void loop(); } };
    void loop();
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, enabled, ...deps]);
}
