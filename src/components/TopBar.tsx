import logo from "../assets/logo.png";
import type { Health, PaperState } from "../types";
import { money, signedMoney, tone, pct } from "../format";
import Flash from "./Flash";

type Props = {
  paper: PaperState | null; health: Health | null; offline: boolean; busy: boolean;
  canStart: boolean; startLabel: string; onToggleEngine: () => void; onOpenSettings: () => void;
};

export default function TopBar({ paper, health, offline, busy, canStart, startLabel, onToggleEngine, onOpenSettings }: Props) {
  const equity = paper?.equity ?? 100000;
  const dayStart = paper?.day_start_equity ?? equity;
  const today = equity - dayStart;
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src={logo} alt="" />
        <span className="brand-name">APEX</span>
        <span className="badge">PAPER</span>
      </div>

      <div className="stats">
        <Stat label="Equity" n={equity} value={money(equity)} big />
        <Stat label="Balance" n={paper?.balance ?? 100000} value={money(paper?.balance ?? 100000)} />
        <Stat label="Open P&L" n={paper?.floating_pnl ?? 0} value={signedMoney(paper?.floating_pnl)} cls={tone(paper?.floating_pnl)} />
        <Stat label="Today" n={today} value={`${signedMoney(today)}`} sub={dayStart ? pct((today / dayStart) * 100) : undefined} cls={tone(today)} />
        <Stat label="Margin used" n={paper?.used_margin ?? 0} value={money(paper?.used_margin)} />
        <Stat label="Free margin" n={paper?.free_margin ?? 100000} value={money(paper?.free_margin ?? equity)}
          sub={paper?.margin_level ? `${paper.margin_level.toFixed(0)}%` : undefined}
          cls={paper?.margin_level && paper.margin_level < 100 ? "down" : paper?.margin_level && paper.margin_level < 200 ? "warn" : ""} />
      </div>

      <div className="topbar-actions">
        <span className={`conn ${offline ? "bad" : "ok"}`} title={offline ? "Backend offline" : `Backend ok · AI ${health?.ai ?? "…"}`}>
          <i />{offline ? "Offline" : "Connected"}
        </span>
        <button className={`btn ${paper?.active ? "btn-ghost" : "btn-go"}`} onClick={onToggleEngine} disabled={busy || (!paper?.active && !canStart)}>
          {paper?.active ? <><span className="pulse" /> Running · Pause</> : startLabel}
        </button>
        <button className="btn btn-icon" onClick={onOpenSettings} title="AI provider settings" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      </div>
    </header>
  );
}

function Stat({ label, value, n, sub, cls = "", big }: { label: string; value: string; n: number; sub?: string; cls?: string; big?: boolean }) {
  return (
    <div className={`stat ${big ? "big" : ""}`}>
      <span>{label}</span>
      <strong className={cls}><Flash value={n}>{value}</Flash>{sub && <small> {sub}</small>}</strong>
    </div>
  );
}
