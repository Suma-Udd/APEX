import { useState } from "react";
import type { AISetup, Backtest, OperationMode, Strategy } from "../types";
import { labelFor } from "../constants";
import { money, pct, price, tone } from "../format";
import Sparkline from "./Sparkline";

type Props = {
  mode: OperationMode; onMode: (m: OperationMode) => void;
  aiSetup: AISetup | null; aiConfigured: boolean; onGenerate: () => void; setupMismatch: boolean;
  strategies: Strategy[]; strategy: Strategy | null; strategyId: string; onStrategy: (id: string) => void;
  params: Record<string, number>; onParam: (k: string, v: number) => void; paramsDirty: boolean; onSaveParams: () => void; paramStatus: string;
  onDuplicate: (name: string) => void;
  backtest: Backtest | null; onBacktest: () => void; busy: boolean; message: string;
};

const MODES: { id: OperationMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "You choose the strategy, parameters and every order." },
  { id: "ai_setup", label: "AI Setup", hint: "AI tunes the selected strategy for this market and shows where it stands. No orders are placed." },
  { id: "ai_auto", label: "AI Auto", hint: "AI tunes the selected strategy, then the engine trades its signals on your paper account while the app is open." },
];

export default function StrategyPanel(p: Props) {
  const [copyName, setCopyName] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const locked = p.mode !== "manual";
  const s = p.strategy;

  return (
    <div className="panel-body">
      <section className="card">
        <h3>Mode</h3>
        <div className="segmented">
          {MODES.map((m) => (
            <button key={m.id} className={p.mode === m.id ? "on" : ""} onClick={() => p.onMode(m.id)} disabled={p.busy}>{m.label}</button>
          ))}
        </div>
        <p className="hint">{MODES.find((m) => m.id === p.mode)?.hint}</p>

        {p.mode !== "manual" && (
          <>
            <button className="btn btn-primary block" onClick={p.onGenerate} disabled={p.busy || !p.aiConfigured}>
              {p.aiSetup ? "Regenerate setup" : "Generate setup"}
            </button>
            {!p.aiConfigured && <p className="hint warn">Connect an AI provider in Settings first.</p>}
          </>
        )}

        {p.aiSetup && p.mode !== "manual" && (
          <div className={`setup-card ${p.aiSetup.direction.startsWith("LONG") ? "long" : p.aiSetup.direction.startsWith("SHORT") ? "short" : "flat"}`}>
            <div className="setup-head">
              <b>{p.aiSetup.direction.startsWith("LONG") ? "In a long" : p.aiSetup.direction.startsWith("SHORT") ? "In a short" : "Flat, waiting for a signal"}</b>
              <span>{p.aiSetup.strategy_name} · {labelFor(p.aiSetup.symbol)} {p.aiSetup.timeframe}</span>
              <span className="mono">{Object.entries(p.aiSetup.parameters).map(([k, v]) => `${paramLabel(k)} ${v}`).join(" · ")}</span>
            </div>
            {!p.aiSetup.direction.startsWith("FLAT") && (
              <div className="setup-levels">
                <div><span>Entry</span><b>{price(p.aiSetup.entry)}</b></div>
                <div><span>Stop</span><b className="down">{p.aiSetup.stop_loss ? price(p.aiSetup.stop_loss) : "–"}</b></div>
                <div><span>Target</span><b className="up">{p.aiSetup.take_profit ? price(p.aiSetup.take_profit) : "signal"}</b></div>
              </div>
            )}
            <p>{p.aiSetup.reason}</p>
            {p.aiSetup.backtest && <p className="hint">These settings on recent history: {p.aiSetup.backtest.trades} trades, {pct(p.aiSetup.backtest.return_pct)}, max drawdown {p.aiSetup.backtest.max_drawdown_pct}%.</p>}
            {p.setupMismatch && <p className="hint warn">This setup is for {labelFor(p.aiSetup.symbol)} {p.aiSetup.timeframe}. Switch the chart back or regenerate.</p>}
          </div>
        )}
        {p.message && <p className="note">{p.message}</p>}
      </section>

      <section className="card">
        <h3>Strategy {locked && <span className="tag">parameters set by AI</span>}</h3>
        <select className="input" value={p.strategyId} disabled={p.busy} onChange={(e) => p.onStrategy(e.target.value)}>
          {p.strategies.map((x) => <option key={x.id} value={x.id}>{x.name}{x.custom ? " (custom)" : ""}</option>)}
        </select>
        {s && (
          <>
            <p className="desc">{s.description}</p>
            <div className="chips">
              <span className="chip accent">{s.category}</span>
              {s.timeframes.map((t) => <span className="chip" key={t}>{t}</span>)}
            </div>
            <details className="rules">
              <summary>Rules and limitations</summary>
              <h4>Entry</h4>{s.entry.map((r, i) => <p key={i}>{r}</p>)}
              <h4>Exit</h4>{s.exit.map((r, i) => <p key={i}>{r}</p>)}
              <h4>Limitations</h4>{s.limitations.map((r, i) => <p key={i}>{r}</p>)}
            </details>

            {Object.keys(s.parameters ?? {}).length > 0 && (
              <div className="params">
                <div className="row-between"><h4>Parameters</h4><small className={p.paramsDirty ? "warn" : "muted"}>{p.paramsDirty ? "Unsaved" : p.paramStatus}</small></div>
                {Object.entries(s.parameters).map(([key, spec]) => (
                  <label className="param" key={key}>
                    <span>{paramLabel(key)}</span>
                    <input className="input" type="number" min={spec.min} max={spec.max} step={spec.type === "integer" ? 1 : 0.1}
                      value={p.params[key] ?? spec.default} disabled={locked}
                      onChange={(e) => p.onParam(key, Number(e.target.value))} />
                    <small>{spec.min}–{spec.max}</small>
                  </label>
                ))}
                <button className="btn btn-secondary block" onClick={p.onSaveParams} disabled={locked || !p.paramsDirty || p.busy}>Save parameters</button>
              </div>
            )}

            {!copyOpen ? (
              <button className="btn btn-link" onClick={() => setCopyOpen(true)}>Duplicate as custom strategy</button>
            ) : (
              <div className="inline-form">
                <input className="input" autoFocus value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder="Name for your copy" />
                <div className="row">
                  <button className="btn btn-primary" disabled={!copyName.trim() || p.busy} onClick={() => { p.onDuplicate(copyName.trim()); setCopyName(""); setCopyOpen(false); }}>Create</button>
                  <button className="btn btn-ghost" onClick={() => setCopyOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="row-between">
          <h3>Backtest</h3>
          <button className="btn btn-secondary sm" onClick={p.onBacktest} disabled={p.busy}>Run</button>
        </div>
        <p className="hint">Last 1,000 candles of the chart's symbol and timeframe. Fills at next open with spread, slippage and fees. Sized at your risk per trade, stops checked on candle highs/lows.</p>
        {p.backtest && (p.backtest.error ? <p className="note bad">{p.backtest.error}</p> : <BacktestResult b={p.backtest} />)}
      </section>
    </div>
  );
}

const ACRONYMS = new Set(["ema", "adx", "rsi", "atr", "macd", "vwap", "bb", "sma"]);
function paramLabel(key: string) {
  const words = key.split("_").map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const out = words.join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function BacktestResult({ b }: { b: Backtest }) {
  const [showTrades, setShowTrades] = useState(false);
  const d = (t?: number) => (t ? new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
  return (
    <div className="bt">
      <Sparkline points={b.equity_curve ?? []} />
      <div className="bt-grid">
        <div><span>Return</span><b className={tone(b.return_pct)}>{pct(b.return_pct)}</b></div>
        <div><span>Net P&L</span><b className={tone(b.net_pnl)}>{money(b.net_pnl)}</b></div>
        <div><span>Max drawdown</span><b className="down">{b.max_drawdown_pct?.toFixed(2)}%</b></div>
        <div><span>Profit factor</span><b>{b.profit_factor ?? (b.wins ? "no losses" : "–")}</b></div>
        <div><span>Trades</span><b>{b.trades} <small className="muted">{b.wins}W {b.losses}L</small></b></div>
        <div><span>Win rate</span><b>{b.win_rate_pct}%</b></div>
        <div><span>Avg R</span><b className={tone(b.avg_r ?? 0)}>{b.avg_r ?? "–"}</b></div>
        <div><span>Sharpe</span><b>{b.sharpe ?? "–"}</b></div>
        <div><span>Time in market</span><b>{b.exposure_pct}%</b></div>
        <div><span>Fees paid</span><b>{money(b.fees_paid)}</b></div>
        <small>{labelFor(b.symbol ?? "")} {b.timeframe} · {d(b.from)} to {d(b.to)} · {b.candles} candles · $10,000 start. Past performance is not indicative of future results.</small>
      </div>
      {!!b.trade_log?.length && <button className="btn btn-link" onClick={() => setShowTrades(!showTrades)}>{showTrades ? "Hide" : "Show"} trades</button>}
      {showTrades && (
        <table className="bt-trades">
          <thead><tr><th>Side</th><th>Exit</th><th>Exit reason</th><th>P&L</th></tr></thead>
          <tbody>
            {b.trade_log!.slice().reverse().map((t, i) => (
              <tr key={i}>
                <td className={t.side === "long" ? "up" : "down"}>{t.side}</td>
                <td>{d(t.exit_time)}</td>
                <td>{t.reason}</td>
                <td className={`num ${tone(t.net_pnl)}`}>{money(t.net_pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
