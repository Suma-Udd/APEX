import type { PaperState, Risk } from "../lib/types";
import { money } from "../lib/format";

type Props = {
  risk: Risk; onChange: (r: Risk) => void; dirty: boolean; onSave: () => void;
  paper: PaperState | null; onReset: () => void; busy: boolean;
};

export default function RiskPanel({ risk, onChange, dirty, onSave, paper, onReset, busy }: Props) {
  const equity = paper?.equity ?? 100000;
  const peak = paper?.peak_equity ?? equity;
  const dayStart = paper?.day_start_equity ?? equity;
  const dd = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;
  const dayLoss = dayStart > 0 ? Math.max(0, ((dayStart - equity) / dayStart) * 100) : 0;
  const set = (k: keyof Risk, v: number) => onChange({ ...risk, [k]: v });

  return (
    <div className="pane">
      <section>
        <h3>Limits</h3>
        <Slider label="Risk per trade" value={risk.risk_pct} min={0.05} max={2} step={0.05} onChange={(v) => set("risk_pct", v)}
          hint={`${money((equity * risk.risk_pct) / 100)} per trade`} />
        <Slider label="Max drawdown" value={risk.max_drawdown_pct} min={0.5} max={25} step={0.5} onChange={(v) => set("max_drawdown_pct", v)}
          hint="From your equity high" />
        <Slider label="Daily loss limit" value={risk.daily_loss_limit_pct} min={0.25} max={10} step={0.25} onChange={(v) => set("daily_loss_limit_pct", v)}
          hint="Resets at 00:00 UTC" />
        <div className="form-group">
          <label className="form-row">
            <span>Max open positions</span>
            <input className="num" type="number" min={1} max={20} value={risk.max_open_positions}
              onChange={(e) => set("max_open_positions", Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
          </label>
        </div>
        {dirty && <button className="btn primary block" onClick={onSave} disabled={busy}>Save limits</button>}
      </section>

      <section>
        <h3>Usage</h3>
        <Meter label="Drawdown" used={dd} limit={risk.max_drawdown_pct} />
        <Meter label="Loss today" used={dayLoss} limit={risk.daily_loss_limit_pct} />
        {paper?.risk_halt && <p className="note bad">{paper.risk_halt}</p>}
      </section>

      <section>
        <h3>Account</h3>
        <button className="btn destructive block" onClick={onReset} disabled={busy}>Reset paper account</button>
        <p className="hint">Clears positions, orders and history. Starts again at $100,000.</p>
      </section>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint: string }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="slider">
      <span className="row-between"><span>{label}</span><b className="num">{value.toFixed(2).replace(/\.?0+$/, "")}%</b></span>
      <input type="range" min={min} max={max} step={step} value={value} style={{ "--pct": `${fill}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <small>{hint}</small>
    </label>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const frac = Math.min(1, used / Math.max(limit, 0.0001));
  return (
    <div className="meter">
      <div className="row-between"><span>{label}</span><span className="num muted">{used.toFixed(2)}% of {limit}%</span></div>
      <div className="meter-track"><i className={frac >= 1 ? "bad" : frac > 0.6 ? "warn" : ""} style={{ width: `${Math.max(frac * 100, 1)}%` }} /></div>
    </div>
  );
}
