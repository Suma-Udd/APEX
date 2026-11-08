import { useEffect, useRef } from "react";

export type ConfirmRequest = {
  title: string; body: string; confirmLabel: string; destructive?: boolean;
  resolve: (ok: boolean) => void;
};

// In-app replacement for window.confirm. The macOS webview Tauri uses (WKWebView)
// doesn't show native confirm() dialogs, it just returns false, so any button
// gated behind confirm() silently did nothing on Mac.
export default function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") req.resolve(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [req]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && req.resolve(false)}>
      <section className="sheet confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{req.title}</h2>
        <p id="confirm-body">{req.body}</p>
        <div className="confirm-actions">
          <button className="btn" onClick={() => req.resolve(false)}>Cancel</button>
          <button ref={okRef} className={req.destructive ? "btn destructive solid" : "btn primary"} onClick={() => req.resolve(true)}>{req.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
