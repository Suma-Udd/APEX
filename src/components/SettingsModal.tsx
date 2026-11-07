import { useEffect, useState } from "react";
import type { AISettings } from "../types";
import type { UpdaterState } from "../updater";

type Props = {
  initial: AISettings; busy: boolean; message: string;
  onSave: (s: { base_url: string; model: string; api_key: string }, test: boolean) => void;
  onClose: () => void;
  version: string; update: UpdaterState; onCheckUpdate: () => void; onInstallUpdate: () => void;
};

export default function SettingsModal({ initial, busy, message, onSave, onClose, version, update, onCheckUpdate, onInstallUpdate }: Props) {
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="row-between">
          <h2 id="settings-title">Settings</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <h3 className="settings-sub">AI provider</h3>
        <p className="hint">Optional. Any OpenAI-compatible endpoint, including FreeLLMAPI. The key is stored locally and never returned to the UI.</p>
        <label className="field"><span>Base URL</span><input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:31415/v1" /></label>
        <label className="field"><span>Model</span><input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" /></label>
        <label className="field"><span>API key {initial.api_key_set && <em className="up">saved</em>}</span>
          <input className="input mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={initial.api_key_set ? "Leave empty to keep the saved key" : "Paste your key"} />
        </label>
        <div className="row end">
          <button className="btn btn-ghost" onClick={() => onSave({ base_url: baseUrl, model, api_key: key }, false)} disabled={busy}>Save</button>
          <button className="btn btn-primary" onClick={() => onSave({ base_url: baseUrl, model, api_key: key }, true)} disabled={busy || (!key.trim() && !initial.api_key_set)}>Save and test</button>
        </div>
        {message && <p className="note">{message}</p>}

        <div className="settings-section">
          <h3>App</h3>
          <div className="row-between">
            <span className="hint">Version <span className="mono">{version || "dev"}</span></span>
            {update.kind === "available"
              ? <button className="btn btn-primary" onClick={onInstallUpdate}>Install {update.version}</button>
              : <button className="btn btn-ghost" onClick={onCheckUpdate} disabled={update.kind === "checking" || update.kind === "downloading"}>
                  {update.kind === "checking" ? "Checking..." : "Check for updates"}
                </button>}
          </div>
          {update.kind === "none" && <p className="note">You're on the latest version.</p>}
          {update.kind === "error" && <p className="note">{update.message}</p>}
        </div>
      </section>
    </div>
  );
}
