import logo from "../assets/logo.png";
import type { BackendStatus } from "../lib/api";
import { isMac } from "../lib/api";

/** Full-window screen while the engine starts, or with the real error if it can't. */
export default function Startup({ status, onRetry }: { status: BackendStatus; onRetry: () => void }) {
  const failed = status.phase === "failed";
  const logFile = status.data_dir ? `${status.data_dir}${isMac ? "/" : "\\"}logs${isMac ? "/" : "\\"}backend-output.log` : "";
  return (
    <div className="startup" data-tauri-drag-region>
      <img src={logo} alt="" width={56} height={56} />
      {!failed ? (
        <>
          <div className="spinner" aria-label="Loading" />
          <p className="muted">Starting APEX…</p>
        </>
      ) : (
        <div className="startup-error">
          <h1>APEX couldn't start its trading engine</h1>
          <p>{status.message || "The engine stopped."}</p>
          {status.log.length > 0 && <pre>{status.log.slice(-12).join("\n")}</pre>}
          <div className="row center">
            <button className="btn primary" onClick={onRetry}>Try again</button>
            {status.log.length > 0 && <button className="btn" onClick={() => void navigator.clipboard?.writeText(status.log.join("\n"))}>Copy details</button>}
          </div>
          {logFile && <p className="hint">Full log: <span className="mono">{logFile}</span></p>}
        </div>
      )}
    </div>
  );
}
