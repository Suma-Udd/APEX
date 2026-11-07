import logo from "../assets/logo.png";
import type { PaperState } from "../lib/types";
import { money, signedMoney, tone } from "../lib/format";
import { Gear, Pause, Play, Sidebar } from "./Icons";
import { Tick, Tween } from "./Motion";

type Props = {
  paper: PaperState | null; busy: boolean; canStart: boolean; startLabel: string;
  onToggleEngine: () => void; onOpenSettings: () => void; onToggleSidebar: () => void;
};

export default function Toolbar({ paper, busy, canStart, startLabel, onToggleEngine, onOpenSettings, onToggleSidebar }: Props) {
  const equity = paper?.equity ?? 100000;
  const dayStart = paper?.day_start_equity ?? equity;
  const today = equity - dayStart;
  const level = paper?.margin_level ?? null;
  const running = !!paper?.active;

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <img src={logo} alt="" width={20} height={20} />
        <span>APEX</span>
        <span className="pill">Paper</span>
      </div>
      <button className="icon-btn" onClick={onToggleSidebar} aria-label="Show or hide the watchlist" title="Watchlist"><Sidebar /></button>

      <div className="toolbar-fill" data-tauri-drag-region />

      <dl className="figures" data-tauri-drag-region>
        <Figure label="Equity" n={equity} fmt={money} />
        <Figure label="Today" n={today} fmt={signedMoney} cls={tone(today)} />
        <Figure label="Open P&L" n={paper?.floating_pnl ?? 0} fmt={signedMoney} cls={tone(paper?.floating_pnl)} />
        <Figure label="Free margin" n={paper?.free_margin ?? equity} fmt={money}
          cls={level !== null && level < 100 ? "down" : level !== null && level < 200 ? "warn" : ""}
          title={level !== null ? `Margin level ${level.toFixed(0)}%` : undefined} />
      </dl>

      <span className="divider" />
      <button className={`engine ${running ? "on" : ""}`} onClick={onToggleEngine} disabled={busy || (!running && !canStart)}
        title={running ? "Pause the engine. Positions stay open." : "Start the paper engine"}>
        {running ? <><i className="live" />Running<Pause size={12} /></> : <><Play size={12} />{startLabel}</>}
      </button>
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings"><Gear /></button>
    </header>
  );
}

function Figure({ label, n, fmt, cls = "", title }: { label: string; n: number; fmt: (n: number) => string; cls?: string; title?: string }) {
  return (
    <div className="figure" title={title}>
      <dt>{label}</dt>
      <dd className={cls}><Tick value={n}><Tween value={n} format={fmt} /></Tick></dd>
    </div>
  );
}
