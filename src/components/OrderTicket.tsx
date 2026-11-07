import { useState } from "react";
import type { Position, Quote } from "../types";
import { money, price as fmt } from "../format";

export type TicketState = { type: string; qty: string; limit: string; stop: string; sl: string; tp: string };

type Props = {
  ticket: TicketState; onChange: (t: TicketState) => void; symbolLabel: string; lastPrice: number | null;
  equity: number; freeMargin: number; riskPct: number; position: Position | null; quote: Quote | null;
  canTrade: boolean; blockedReason: string; busy: boolean; message: string;
  onSubmit: (side: "buy" | "sell") => void;
};

export default function OrderTicket({ ticket, onChange, symbolLabel, lastPrice, equity, freeMargin, riskPct, position, quote, canTrade, blockedReason, busy, message, onSubmit }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const set = (k: keyof TicketState, v: string) => onChange({ ...ticket, [k]: v });
  const q = Number(ticket.qty) || 0;
  const s = quote?.session;
  const marketPx = quote ? (side === "buy" ? quote.ask : quote.bid) : lastPrice || 0;
  const entry = ticket.type === "limit" || ticket.type === "stop_limit" ? Number(ticket.limit) || marketPx
    : ticket.type === "stop" ? Number(ticket.stop) || marketPx : marketPx;
  const leverage = s?.leverage ?? 1;
  const margin = (q * entry) / leverage;
  const fee = s ? Math.max((q * entry * s.taker_bps) / 10000, q > 0 ? s.min_fee : 0) : 0;
  const spread = quote ? quote.ask - quote.bid : 0;
  const maxQty = entry > 0 ? (Math.max(0, freeMargin) * leverage * 0.98) / entry : 0;
  const sl = Number(ticket.sl) || 0;
  const notional = q * entry;
  const riskAmount = sl && entry ? Math.abs(entry - sl) * q : 0;

  const sizeFromRisk = () => {
    if (!sl || !entry || sl === entry) return;
    const size = ((equity * riskPct) / 100) / Math.abs(entry - sl);
    const capped = Math.min(size, maxQty);
    set("qty", String(Number(capped.toPrecision(4))));
  };

  return (
    <section className="ticket">
      <div className="ticket-head">
        <div className="side-toggle">
          <button className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>Buy</button>
          <button className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>Sell</button>
        </div>
        <h3>{symbolLabel}</h3>
        {position && <span className="chip">{position.quantity > 0 ? "Long" : "Short"} {Math.abs(position.quantity).toLocaleString()} @ {fmt(position.avg_price)}</span>}
      </div>
      <div className="ticket-grid">
        <label className="field"><span>Type</span>
          <select className="input" value={ticket.type} onChange={(e) => set("type", e.target.value)}>
            <option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option><option value="stop_limit">Stop limit</option>
          </select>
        </label>
        <label className="field"><span>Quantity</span>
          <input className="input mono" type="number" min="0" step="any" value={ticket.qty} onChange={(e) => set("qty", e.target.value)} />
        </label>
        {(ticket.type === "stop" || ticket.type === "stop_limit") && (
          <label className="field"><span>Stop trigger</span><input className="input mono" type="number" step="any" value={ticket.stop} placeholder={lastPrice ? fmt(lastPrice) : ""} onChange={(e) => set("stop", e.target.value)} /></label>
        )}
        {(ticket.type === "limit" || ticket.type === "stop_limit") && (
          <label className="field"><span>Limit price</span><input className="input mono" type="number" step="any" value={ticket.limit} placeholder={lastPrice ? fmt(lastPrice) : ""} onChange={(e) => set("limit", e.target.value)} /></label>
        )}
        <label className="field"><span>Stop loss <em>or drag on chart</em></span><input className="input mono sl" type="number" step="any" placeholder="Optional" value={ticket.sl} onChange={(e) => set("sl", e.target.value)} /></label>
        <label className="field"><span>Take profit</span><input className="input mono tp" type="number" step="any" placeholder="Optional" value={ticket.tp} onChange={(e) => set("tp", e.target.value)} /></label>
      </div>
      <div className="ticket-foot">
        <div className="ticket-info">
          <span>Value <b className="mono">{money(notional)}</b></span>
          <span title={`${leverage}:1 leverage`}>Margin <b className={`mono ${margin > freeMargin ? "down" : ""}`}>{money(margin)}</b></span>
          <span>Fee <b className="mono">{money(fee)}</b></span>
          <span>Spread <b className="mono">{spread ? fmt(spread) : "–"}</b></span>
          <button className="btn btn-link" onClick={() => set("qty", String(Number((maxQty * 0.999).toPrecision(4))))} disabled={!maxQty} title="Largest size your free margin allows">Max {maxQty ? Number(maxQty.toPrecision(3)).toLocaleString() : ""}</button>
          <span>Risk <b className="mono">{riskAmount ? `${money(riskAmount)} (${((riskAmount / equity) * 100).toFixed(2)}%)` : "–"}</b></span>
          <button className="btn btn-link" onClick={sizeFromRisk} disabled={!sl} title={`Size the order so the stop costs ${riskPct}% of equity`}>Size to {riskPct}% risk</button>
        </div>
        <button className={`btn ticket-submit ${side === "buy" ? "btn-buy" : "btn-sell"}`} onClick={() => onSubmit(side)} disabled={busy || !canTrade || q <= 0}>
          {side === "buy" ? "Buy" : "Sell"} {q > 0 ? Number(q.toPrecision(6)).toLocaleString() : ""} {symbolLabel}
        </button>
      </div>
      {(message || blockedReason) && <p className={`note ${message ? "" : "warn"}`}>{message || blockedReason}</p>}
    </section>
  );
}
