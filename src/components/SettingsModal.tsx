import { useEffect, useState } from "react";
import type { AISettings } from "../lib/types";
import type { UpdaterState } from "../lib/updater";
import type { ThemePref } from "../lib/theme";
import { Close } from "./Icons";

type Props = {
  initial: AISettings; busy: boolean; message: string;
  onSave: (s: { base_url: string; model: string; api_key: string }, test: boolean) => void;
  onClose: () => void; theme: ThemePref; onTheme: (t: ThemePref) => void;
  version: string; update: UpdaterState; onCheckUpdate: () => void; onInstallUpdate: () => void;
};

export default function SettingsModal({ initial, busy, message, onSave, onClose, theme, onTheme, version, update, onCheckUpdate, onInstallUpdate }: Props) {
  // Local draft: background refreshes can't wipe what you're typing.
  const [baseUrl, setBaseUrl] = useState(initial.base_url);
  const [model, setModel] = useState(initial.model);
  const [key, setKey] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Close size={15} /></button>
        </header>

        <h3>Appearance</h3>
        <div className="seg full" role="tablist" aria-label="Appearance">
          {(["system", "light", "dark"] as ThemePref[]).map((t) => (
            <button key={t} role="tab" aria-selected={theme === t} className={theme === t ? "on" : ""} onClick={() => onTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>

        <h3>AI provider</h3>
        <p className="hint">Optional. Any OpenAI-compatible endpoint. The key stays on this computer.</p>
        <div className="form-group stacked">
          <label className="form-row"><span>Base URL</span><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:31415/v1" spellCheck={false} /></label>
          <label className="form-row"><span>Model</span><input value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" spellCheck={false} /></label>
          <label className="form-row"><span>API key</span>
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={initial.api_key_set ? "Saved" : "Paste your key"} />
          </label>
        </div>
        <div className="row end">
          <button className="btn" onClick={() => onSave({ base_url: baseUrl, model, api_key: key }, false)} disabled={busy}>Save</button>
          <button className="btn primary" onClick={() => onSave({ base_url: baseUrl, model, api_key: key }, true)} disabled={busy || (!key.trim() && !initial.api_key_set)}>Save and test</button>
        </div>
        {message && <p className="note">{message}</p>}

        <h3>About</h3>
        <div className="about">
          <span>APEX <span className="num muted">{version || "dev"}</span></span>
          {update.kind === "available"
            ? <button className="btn primary" onClick={onInstallUpdate}>Install {update.version}</button>
            : <button className="btn" onClick={onCheckUpdate} disabled={update.kind === "checking" || update.kind === "downloading"}>{update.kind === "checking" ? "Checking…" : "Check for updates"}</button>}
        </div>
        {update.kind === "none" && <p className="note">You're up to date.</p>}
        {update.kind === "error" && <p className="note bad">{update.message}</p>}
        <p className="hint">Simulated trading only. No broker connection, no real money. Market data from Binance and Yahoo Finance.</p>
      </section>
    </div>
  );
}
