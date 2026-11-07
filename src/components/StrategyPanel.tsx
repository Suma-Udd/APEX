import { useState } from "react";
import type { AISetup, Backtest, OperationMode, Strategy } from "../lib/types";
import { labelFor } from "../lib/constants";
import { money, pct, price, tone } from "../lib/format";
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
  { id: "manual", label: "Manual", hint: "You place every order." },
  { id: "ai_setup", label: "AI Setup", hint: "AI tunes the strategy for this chart. It never trades." },
  { id: "ai_auto", label: "AI Auto", hint: "AI tunes the strategy, then trades its signals on paper." },
];

export default function StrategyPanel(p: Props) {
  const [copyName, setCopyName] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const locked = p.mode !== "manual";
  const s = p.strategy;

  return (
    <div className="pane">
      <section>
        <div className="seg full" role="tablist" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={p.mode === m.id} className={p.mode === m.id ? "on" : ""} onClick={() => p.onMode(m.id)} disabled={p.busy}>{m.label}</button>
          ))}
        </div>
        <p className="hint">{MODES.find((m) => m.id === p.mode)?.hint}</p>
        {p.mode !== "manual" && (
          <>
            <button className="btn primary block" onClick={p.onGenerate} disabled={p.busy || !p.aiConfigured}>{p.aiSetup ? "Regenerate setup" : "Generate setup"}</button>
            {!p.aiConfigured && <p className="hint warn">Connect an AI provider in Settings first.</p>}
          </>
        )}
        {p.aiSetup && p.mode !== "manual" && (
          <div className={`setup ${p.aiSetup.direction.startsWith("LONG") ? "long" : p.aiSetup.direction.startsWith("SHORT") ? "short" : ""}`}>
            <div className="setup-title">
              <b>{p.aiSetup.direction.startsWith("LONG") ? "Long" : p.aiSetup.direction.startsWith("SHORT") ? "Short" : "Waiting for a signal"}</b>
              <small>{labelFor(p.aiSetup.symbol)} · {p.aiSetup.timeframe}</small>
            </div>
            {!p.aiSetup.direction.startsWith("FLAT") && (
              <dl className="facts three">
                <div><dt>Entry</dt><dd className="num">{price(p.aiSetup.entry)}</dd></div>
                <div><dt>Stop</dt><dd className="num down">{p.aiSetup.stop_loss ? price(p.aiSetup.stop_loss) : "–"}</dd></div>
                <div><dt>Target</dt><dd className="num up">{p.aiSetup.take_profit ? price(p.aiSetup.take_profit) : "Signal"}</dd></div>
              </dl>
            )}
            <p>{p.aiSetup.reason}</p>
            {p.aiSetup.backtest && <p className="hint">Recent history: {p.aiSetup.backtest.trades} trades, {pct(p.aiSetup.backtest.return_pct)}, max drawdown {p.aiSetup.backtest.max_drawdown_pct}%.</p>}
            {p.setupMismatch && <p className="hint warn">Made for {labelFor(p.aiSetup.symbol)} {p.aiSetup.timeframe}. Switch back or regenerate.</p>}
          </div>
        )}
        {p.message && <p className="note">{p.message}</p>}
      </section>

      <section>
        <h3>Strategy {locked && <small className="muted">set by AI</small>}</h3>
        <div className="select-wrap">
          <select value={p.strategyId} disabled={p.busy} onChange={(e) => p.onStrategy(e.target.value)} aria-label="Strategy">
            {p.strategies.map((x) => <option key={x.id} value={x.id}>{x.name}{x.custom ? " (custom)" : ""}</option>)}
          </select>
        </div>
        {s && (
          <>
            <p className="hint">{s.description}</p>
            <details className="rules">
              <summary>Rules</summary>
              <h4>Entry</h4>{s.entry.map((r, i) => <p key={i}>{r}</p>)}
              <h4>Exit</h4>{s.exit.map((r, i) => <p key={i}>{r}</p>)}
              {s.limitations.length > 0 && <><h4>Limitations</h4>{s.limitations.map((r, i) => <p key={i}>{r}</p>)}</>}
            </details>
            {Object.keys(s.parameters ?? {}).length > 0 && (
              <>
                <div className="form-group">
                  {Object.entries(s.parameters).map(([key, spec]) => (
                    <label className="form-row" key={key} title={`${spec.min} to ${spec.max}`}>
                      <span>{paramLabel(key)}</span>
                      <input className="num" type="number" min={spec.min} max={spec.max} step={spec.type === "integer" ? 1 : 0.1}
                        value={p.params[key] ?? spec.default} disabled={locked} onChange={(e) => p.onParam(key, Number(e.target.value))} />
                    </label>
                  ))}
                </div>
                {p.paramsDirty && !locked && <button className="btn block" onClick={p.onSaveParams} disabled={p.busy}>Save parameters</button>}
              </>
            )}
            {!copyOpen ? (
              <button className="link" onClick={() => setCopyOpen(true)}>Duplicate as my own strategy</button>
            ) : (
              <form className="inline" onSubmit={(e) => { e.preventDefault(); if (copyName.trim()) { p.onDuplicate(copyName.trim()); setCopyName(""); setCopyOpen(false); } }}>
                <input className="field" autoFocus value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder="Name" aria-label="Name for your copy" />
                <button className="btn primary" disabled={!copyName.trim() || p.busy}>Create</button>
                <button type="button" className="btn" onClick={() => setCopyOpen(false)}>Cancel</button>
              </form>
            )}
          </>
        )}
      </section>

      <section>
        <div className="row-between">
          <h3>Backtest</h3>
          <button className="btn small" onClick={p.onBacktest} disabled={p.busy}>Run</button>
        </div>
        <p className="hint">Last 1,000 candles of this chart, with spread, fees and your risk per trade.</p>
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
      <dl className="facts grid">
        <div><dt>Return</dt><dd className={"num " + tone(b.return_pct)}>{pct(b.return_pct)}</dd></div>
        <div><dt>Net P&L</dt><dd className={"num " + tone(b.net_pnl)}>{money(b.net_pnl)}</dd></div>
        <div><dt>Max drawdown</dt><dd className="num down">{b.max_drawdown_pct?.toFixed(2)}%</dd></div>
        <div><dt>Profit factor</dt><dd>{b.profit_factor ?? (b.wins ? "no losses" : "–")}</dd></div>
        <div><dt>Trades</dt><dd>{b.trades} <small className="muted">{b.wins}W {b.losses}L</small></dd></div>
        <div><dt>Win rate</dt><dd>{b.win_rate_pct}%</dd></div>
        <div><dt>Avg R</dt><dd className={"num " + tone(b.avg_r ?? 0)}>{b.avg_r ?? "–"}</dd></div>
        <div><dt>Sharpe</dt><dd>{b.sharpe ?? "–"}</dd></div>
        <div><dt>Time in market</dt><dd>{b.exposure_pct}%</dd></div>
        <div><dt>Fees paid</dt><dd>{money(b.fees_paid)}</dd></div>
      </dl>
      <p className="hint">{labelFor(b.symbol ?? "")} {b.timeframe}, {d(b.from)} to {d(b.to)}, $10,000 start. Past results don't predict future ones.</p>
      {!!b.trade_log?.length && <button className="link" onClick={() => setShowTrades(!showTrades)}>{showTrades ? "Hide" : "Show"} trades</button>}
      {showTrades && (
        <table className="table compact">
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
