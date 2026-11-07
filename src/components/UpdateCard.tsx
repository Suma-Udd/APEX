import type { UpdaterState } from "../lib/updater";
import { Close } from "./Icons";

type Props = { state: UpdaterState; onInstall: () => void; onLater: () => void };

export default function UpdateCard({ state, onInstall, onLater }: Props) {
  if (state.kind !== "available" && state.kind !== "downloading") return null;
  const downloading = state.kind === "downloading";
  return (
    <section className="update-card" role="status" aria-live="polite">
      <div className="row-between">
        <h3>APEX {state.version} is available</h3>
        {!downloading && <button className="icon-btn" onClick={onLater} aria-label="Later"><Close size={14} /></button>}
      </div>
      {state.kind === "available" && state.notes && <p className="update-notes">{state.notes}</p>}
      {downloading ? (
        <>
          <div className="progress"><i style={{ width: `${state.percent ?? 12}%` }} className={state.percent == null ? "indeterminate" : ""} /></div>
          <p className="hint">Downloading{state.percent != null ? ` ${state.percent}%` : ""}. APEX restarts when it's done.</p>
        </>
      ) : (
        <div className="row end">
          <button className="btn" onClick={onLater}>Later</button>
          <button className="btn primary" onClick={onInstall}>Update and restart</button>
        </div>
      )}
    </section>
  );
}
