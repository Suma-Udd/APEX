import type { UpdaterState } from "../updater";

type Props = { state: UpdaterState; onInstall: () => void; onLater: () => void };

export default function UpdateCard({ state, onInstall, onLater }: Props) {
  if (state.kind !== "available" && state.kind !== "downloading") return null;
  const downloading = state.kind === "downloading";
  return (
    <section className="update-card" role="status" aria-live="polite">
      <div className="row-between">
        <h3>APEX {state.version} is out</h3>
        {!downloading && <button className="btn btn-icon" onClick={onLater} aria-label="Later">✕</button>}
      </div>
      {state.kind === "available" && state.notes && <p className="update-notes">{state.notes}</p>}
      {downloading ? (
        <>
          <div className="update-bar"><i style={{ width: `${state.percent ?? 15}%` }} className={state.percent == null ? "indeterminate" : ""} /></div>
          <p className="hint">Downloading{state.percent != null ? ` ${state.percent}%` : ""}. APEX restarts by itself when it's done.</p>
        </>
      ) : (
        <>
          <p className="hint">Your paper account stays as it is. The engine starts paused after the restart.</p>
          <div className="row end">
            <button className="btn btn-ghost" onClick={onLater}>Later</button>
            <button className="btn btn-primary" onClick={onInstall}>Update and restart</button>
          </div>
        </>
      )}
    </section>
  );
}
