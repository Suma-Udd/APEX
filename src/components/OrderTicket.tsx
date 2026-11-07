import type { Position, Quote } from "../lib/types";
import { money, price as fmt, qty as fmtQty } from "../lib/format";

export type TicketState = { side: "buy" | "sell"; type: string; qty: string; limit: string; stop: string; sl: string; tp: string };

type Props = {
  ticket: TicketState; onChange: (t: TicketState) => void; symbolLabel: string; lastPrice: number | null;
  equity: number; freeMargin: number; riskPct: number; position: Position | null; quote: Quote | null;
  canTrade: boolean; blockedReason: string; busy: boolean; message: string;
  onSubmit: (side: "buy" | "sell") => void;
};

const TYPES = [["market", "Market"], ["limit", "Limit"], ["stop", "Stop"], ["stop_limit", "Stop limit"]] as const;

export default function OrderTicket({ ticket, onChange, symbolLabel, lastPrice, equity, freeMargin, riskPct, position, quote, canTrade, blockedReason, busy, message, onSubmit }: Props) {
  const side = ticket.side;
  const set = (k: keyof TicketState, v: string) => onChange({ ...ticket, [k]: v });
  const q = Number(ticket.qty) || 0;
  const s = quote?.session;
  const marketPx = quote ? (side === "buy" ? quote.ask : quote.bid) : lastPrice || 0;
  const entry = ticket.type === "limit" || ticket.type === "stop_limit" ? Number(ticket.limit) || marketPx
    : ticket.type === "stop" ? Number(ticket.stop) || marketPx : marketPx;
  const leverage = s?.leverage ?? 1;
  const margin = (q * entry) / leverage;
  const fee = s ? Math.max((q * entry * s.taker_bps) / 10000, q > 0 ? s.min_fee : 0) : 0;
  const maxQty = entry > 0 ? (Math.max(0, freeMargin) * leverage * 0.98) / entry : 0;
  const sl = Number(ticket.sl) || 0;
  const riskAmount = sl && entry ? Math.abs(entry - sl) * q : 0;
  const needsStop = ticket.type === "stop" || ticket.type === "stop_limit";
  const needsLimit = ticket.type === "limit" || ticket.type === "stop_limit";

  const sizeFromRisk = () => {
    if (!sl || !entry || sl === entry) return;
    const size = ((equity * riskPct) / 100) / Math.abs(entry - sl);
    set("qty", String(Number(Math.min(size, maxQty).toPrecision(4))));
  };

  return (
    <div className="ticket">
      <div className="sides">
        <button className={`side buy ${side === "buy" ? "on" : ""}`} onClick={() => set("side", "buy")} aria-pressed={side === "buy"}>
          <span>Buy</span><b className="num">{quote ? fmt(quote.ask) : "–"}</b>
        </button>
        <button className={`side sell ${side === "sell" ? "on" : ""}`} onClick={() => set("side", "sell")} aria-pressed={side === "sell"}>
          <span>Sell</span><b className="num">{quote ? fmt(quote.bid) : "–"}</b>
        </button>
      </div>

      <div className="seg full" role="tablist" aria-label="Order type">
        {TYPES.map(([id, label]) => <button key={id} role="tab" aria-selected={ticket.type === id} className={ticket.type === id ? "on" : ""} onClick={() => set("type", id)}>{label}</button>)}
      </div>

      <div className="form-group">
        <Row label="Quantity">
          <input className="num" type="number" min="0" step="any" value={ticket.qty} onChange={(e) => set("qty", e.target.value)} aria-label="Quantity" />
        </Row>
        {needsStop && <Row label="Trigger"><input className="num" type="number" step="any" value={ticket.stop} placeholder={lastPrice ? fmt(lastPrice) : ""} onChange={(e) => set("stop", e.target.value)} aria-label="Stop trigger" /></Row>}
        {needsLimit && <Row label="Limit"><input className="num" type="number" step="any" value={ticket.limit} placeholder={lastPrice ? fmt(lastPrice) : ""} onChange={(e) => set("limit", e.target.value)} aria-label="Limit price" /></Row>}
        <Row label="Stop loss" cls="sl"><input className="num" type="number" step="any" placeholder="None" value={ticket.sl} onChange={(e) => set("sl", e.target.value)} aria-label="Stop loss" /></Row>
        <Row label="Take profit" cls="tp"><input className="num" type="number" step="any" placeholder="None" value={ticket.tp} onChange={(e) => set("tp", e.target.value)} aria-label="Take profit" /></Row>
      </div>
      <div className="quick">
        <button className="link" onClick={() => set("qty", String(Number((maxQty * 0.999).toPrecision(4))))} disabled={!maxQty} title="Largest size your free margin allows">Max {maxQty ? fmtQty(Number(maxQty.toPrecision(3))) : ""}</button>
        <button className="link" onClick={sizeFromRisk} disabled={!sl} title={sl ? `Size so the stop costs ${riskPct}% of equity` : "Set a stop loss first (or drag one on the chart)"}>Size to {riskPct}% risk</button>
      </div>

      <dl className="facts">
        <div><dt>Margin <small>{leverage}:1</small></dt><dd className={`num ${margin > freeMargin ? "down" : ""}`}>{money(margin)}</dd></div>
        <div><dt>Risk if stopped</dt><dd className="num">{riskAmount ? `${money(riskAmount)} · ${((riskAmount / equity) * 100).toFixed(2)}%` : "–"}</dd></div>
        <div><dt>Fee</dt><dd className="num">{money(fee)}</dd></div>
      </dl>

      <div className="ticket-foot">
        {position && <p className="holding">You hold {position.quantity > 0 ? "long" : "short"} {fmtQty(Math.abs(position.quantity))} @ {fmt(position.avg_price)}</p>}
        <button className={`submit ${side}`} onClick={() => onSubmit(side)} disabled={busy || !canTrade || q <= 0}>
          {side === "buy" ? "Buy" : "Sell"} {q > 0 ? fmtQty(Number(q.toPrecision(6))) : ""} {symbolLabel}
        </button>
        {(message || blockedReason) && <p className={`note ${message ? "bad" : ""}`}>{message || blockedReason}</p>}
      </div>
    </div>
  );
}

function Row({ label, children, cls = "" }: { label: string; children: React.ReactNode; cls?: string }) {
  return <label className={`form-row ${cls}`}><span>{label}</span>{children}</label>;
}
