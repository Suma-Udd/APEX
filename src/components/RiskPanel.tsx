import type { PaperState, Risk } from "../types";
import { money } from "../format";

type Props = {
  risk: Risk; onChange: (r: Risk) => void; dirty: boolean; onSave: () => void; status: string;
  paper: PaperState | null; onReset: () => void; busy: boolean;
};

export default function RiskPanel({ risk, onChange, dirty, onSave, status, paper, onReset, busy }: Props) {
  const equity = paper?.equity ?? 100000;
  const peak = paper?.peak_equity ?? equity;
  const dayStart = paper?.day_start_equity ?? equity;
  const dd = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;
  const dayLoss = dayStart > 0 ? Math.max(0, ((dayStart - equity) / dayStart) * 100) : 0;
  const set = (k: keyof Risk, v: number) => onChange({ ...risk, [k]: v });

  return (
    <div className="panel-body">
      <section className="card">
        <div className="row-between"><h3>Limits</h3><small className={dirty ? "warn" : "muted"}>{dirty ? "Unsaved" : status}</small></div>

        <Slider label="Risk per trade" value={risk.risk_pct} min={0.05} max={2} step={0.05} unit="%" onChange={(v) => set("risk_pct", v)}
          hint={`${money((equity * risk.risk_pct) / 100)} at risk per trade at current equity.`} />
        <Slider label="Max drawdown" value={risk.max_drawdown_pct} min={0.5} max={25} step={0.5} unit="%" onChange={(v) => set("max_drawdown_pct", v)}
          hint="Blocks new exposure when equity falls this far below its high." />
        <Slider label="Daily loss limit" value={risk.daily_loss_limit_pct} min={0.25} max={10} step={0.25} unit="%" onChange={(v) => set("daily_loss_limit_pct", v)}
          hint="Blocks new exposure for the rest of the UTC day." />
        <label className="field">
          <span>Max open positions</span>
          <input className="input" type="number" min={1} max={20} value={risk.max_open_positions} onChange={(e) => set("max_open_positions", Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        </label>
        <button className="btn btn-primary block" onClick={onSave} disabled={!dirty || busy}>Save</button>
      </section>

      <section className="card">
        <h3>Limit usage</h3>
        <Meter label="Drawdown from peak" used={dd} limit={risk.max_drawdown_pct} />
        <Meter label="Loss today" used={dayLoss} limit={risk.daily_loss_limit_pct} />
        {paper?.risk_halt && <p className="note bad">{paper.risk_halt}</p>}
      </section>

      <section className="card">
        <h3>Account</h3>
        <p className="hint">Clears positions, orders and history. Balance resets to $100,000.</p>
        <button className="btn btn-danger-ghost block" onClick={onReset} disabled={busy}>Reset paper account</button>
      </section>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange, hint }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void; hint: string }) {
  return (
    <label className="field">
      <span className="row-between"><span>{label}</span><b className="mono">{value.toFixed(2).replace(/\.?0+$/, "")}{unit}</b></span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <small className="muted">{hint}</small>
    </label>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const frac = Math.min(1, used / Math.max(limit, 0.0001));
  return (
    <div className="meter">
      <div className="row-between"><span>{label}</span><span className="mono">{used.toFixed(2)}% / {limit}%</span></div>
      <div className="meter-track"><div className={`meter-fill ${frac >= 1 ? "bad" : frac > 0.6 ? "warn" : ""}`} style={{ width: `${frac * 100}%` }} /></div>
    </div>
  );
}
