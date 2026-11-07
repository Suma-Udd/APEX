import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "error"; message: string };

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Checks GitHub Releases a few seconds after launch and every 6 hours. */
export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ kind: "idle" });
  const [version, setVersion] = useState<string>("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pending = useRef<Update | null>(null);

  const runCheck = useCallback(async (manual: boolean) => {
    if (!inDesktopApp) {
      if (manual) setState({ kind: "error", message: "Updates only work in the installed app." });
      return;
    }
    setState({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        pending.current = update;
        setState({ kind: "available", version: update.version, notes: update.body ?? "" });
        if (manual) setDismissed(null);
      } else {
        pending.current = null;
        setState({ kind: "none" });
      }
    } catch (error) {
      // Offline or no release yet: stay quiet unless the user asked.
      setState(manual ? { kind: "error", message: "Couldn't reach GitHub to check for updates." } : { kind: "idle" });
      if (!manual) console.warn("update check failed", error);
    }
  }, []);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    let total = 0;
    let got = 0;
    setState({ kind: "downloading", version: update.version, percent: null });
    try {
      // The installer can't replace the backend while it runs (Windows), so stop it first.
      await invoke("stop_backend").catch(() => undefined);
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          got += event.data.chunkLength;
          setState({ kind: "downloading", version: update.version, percent: total ? Math.min(100, Math.round((got / total) * 100)) : null });
        }
      });
      await relaunch();
    } catch (error) {
      setState({ kind: "error", message: `Update failed: ${error instanceof Error ? error.message : String(error)}. Restart APEX and try again.` });
    }
  }, []);

  useEffect(() => {
    if (!inDesktopApp) return;
    getVersion().then(setVersion).catch(() => undefined);
    const first = window.setTimeout(() => void runCheck(false), 4000);
    const every = window.setInterval(() => void runCheck(false), SIX_HOURS);
    return () => { window.clearTimeout(first); window.clearInterval(every); };
  }, [runCheck]);

  const showCard = (state.kind === "available" && dismissed !== state.version) || state.kind === "downloading";
  const dismiss = () => state.kind === "available" && setDismissed(state.version);

  return { state, version, showCard, check: () => runCheck(true), install, dismiss };
}
