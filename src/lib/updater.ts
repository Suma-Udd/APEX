import { useCallback, useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { inDesktopApp } from "./api";

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "error"; message: string };

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Checks GitHub Releases a few seconds after launch and every 6 hours.
 * Download and install run in the Rust shell, which stops the backend right
 * before the installer replaces its files.
 */
export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ kind: "idle" });
  const [version, setVersion] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);

  const runCheck = useCallback(async (manual: boolean) => {
    if (!inDesktopApp) {
      if (manual) setState({ kind: "error", message: "Updates only work in the installed app." });
      return;
    }
    setState({ kind: "checking" });
    try {
      const update = await invoke<{ version: string; notes: string } | null>("update_check");
      if (update) {
        setState({ kind: "available", version: update.version, notes: update.notes });
        if (manual) setDismissed(null);
      } else setState({ kind: "none" });
    } catch (error) {
      setState(manual ? { kind: "error", message: "Couldn't reach GitHub to check for updates." } : { kind: "idle" });
      if (!manual) console.warn("update check failed", error);
    }
  }, []);

  const install = useCallback(async () => {
    if (state.kind !== "available") return;
    const v = state.version;
    setState({ kind: "downloading", version: v, percent: null });
    const progress = new Channel<[number, number]>();
    progress.onmessage = ([got, total]) => {
      setState({ kind: "downloading", version: v, percent: total ? Math.min(100, Math.round((got / total) * 100)) : null });
    };
    try {
      await invoke("update_install", { progress });
    } catch (error) {
      setState({ kind: "error", message: `Update failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }, [state]);

  useEffect(() => {
    if (!inDesktopApp) return;
    getVersion().then(setVersion).catch(() => undefined);
    const first = window.setTimeout(() => void runCheck(false), 5000);
    const every = window.setInterval(() => void runCheck(false), SIX_HOURS);
    return () => { window.clearTimeout(first); window.clearInterval(every); };
  }, [runCheck]);

  const showCard = (state.kind === "available" && dismissed !== state.version) || state.kind === "downloading";
  const dismiss = () => state.kind === "available" && setDismissed(state.version);

  return { state, version, showCard, check: () => runCheck(true), install, dismiss };
}
