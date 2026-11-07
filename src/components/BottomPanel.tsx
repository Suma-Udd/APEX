import { useEffect, useRef, useState } from "react";
import type { LogItem, Order, PaperState, Position } from "../lib/types";
import { labelFor } from "../lib/constants";
import { money, price, qty, signedMoney, time, tone } from "../lib/format";
import Sparkline from "./Sparkline";

export type BottomTab = "positions" | "orders" | "history" | "activity" | "assistant";
type ChatMsg = { role: "user" | "assistant"; text: string };
type Props = {
  tab: BottomTab; onTab: (t: BottomTab) => void;
  paper: PaperState | null; logs: LogItem[]; busy: boolean;
  onSelectSymbol: (api: string) => void; onClosePosition: (p: Position) => void; onCancelOrder: (o: Order) => void; onCloseAll: () => void;
  chat: ChatMsg[]; onSendChat: (text: string) => void; chatPending: boolean; aiConfigured: boolean; strategyName: string;
};

export default function BottomPanel(p: Props) {
  const positions = p.paper?.positions ?? [];
  const working = (p.paper?.orders ?? []).filter((o) => o.status === "pending" || o.status === "triggered");
  const closed = (p.paper?.orders ?? []).filter((o) => o.status === "rejected" || o.status === "cancelled").slice(-8).reverse();
  const trades = (p.paper?.trades ?? []).slice(-80).reverse();
  const tabs: [BottomTab, string, number?][] = [
    ["positions", "Positions", positions.length], ["orders", "Orders", working.length], ["history", "History"], ["activity", "Activity"], ["assistant", "Assistant"],
  ];

  return (
    <section className="bottom">
      <div className="bottom-bar">
        <div className="tabs" role="tablist">
          {tabs.map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? "on" : ""} onClick={() => p.onTab(id)}>
              {label}{n ? <span className="count">{n}</span> : null}
            </button>
          ))}
        </div>
        {p.tab === "positions" && positions.length > 0 && <button className="link danger" onClick={p.onCloseAll} disabled={p.busy}>Close all</button>}
      </div>

      <div className="bottom-body">
        {p.tab === "positions" && (positions.length === 0 ? <Empty text="No open positions" /> : (
          <table className="table">
            <thead><tr><th>Symbol</th><th>Size</th><th>Entry</th><th>Mark</th><th>Stop</th><th>Target</th><th>Margin</th><th className="r">P&L</th><th /></tr></thead>
            <tbody>
              {positions.map((pos) => {
                const long = pos.quantity > 0;
                return (
                  <tr key={pos.id} onClick={() => p.onSelectSymbol(pos.symbol)} className="clickable">
                    <td><b>{labelFor(pos.symbol)}</b> <span className={`tag ${long ? "long" : "short"}`}>{long ? "Long" : "Short"}</span></td>
                    <td className="num">{qty(Math.abs(pos.quantity))}</td>
                    <td className="num">{price(pos.avg_price)}</td>
                    <td className="num">{price(long ? pos.bid ?? pos.mark_price : pos.ask ?? pos.mark_price)}</td>
                    <td className="num muted">{pos.stop_loss ? price(pos.stop_loss) : "–"}</td>
                    <td className="num muted">{pos.take_profit ? price(pos.take_profit) : "–"}</td>
                    <td className="num muted">{money(pos.margin)}</td>
                    <td className={`num r strong ${tone(pos.unrealized_pnl)}`}>{signedMoney(pos.unrealized_pnl)}</td>
                    <td className="r"><button className="btn small" onClick={(e) => { e.stopPropagation(); p.onClosePosition(pos); }} disabled={p.busy}>Close</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}

        {p.tab === "orders" && (working.length === 0 && closed.length === 0 ? <Empty text="No working orders" /> : (
          <table className="table">
            <thead><tr><th>Order</th><th>Type</th><th>Size</th><th>Trigger</th><th>Limit</th><th>Status</th><th /></tr></thead>
            <tbody>
              {working.map((o) => (
                <tr key={o.id}>
                  <td><b className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "Buy" : "Sell"}</b> {labelFor(o.symbol)}</td>
                  <td className="cap">{o.type.replace("_", " ")}</td>
                  <td className="num">{qty(o.quantity)}</td>
                  <td className="num">{o.stop_price ? price(o.stop_price) : "–"}</td>
                  <td className="num">{o.limit_price ? price(o.limit_price) : "–"}</td>
                  <td className="cap">{o.status === "triggered" ? "Triggered" : "Working"}</td>
                  <td className="r"><button className="btn small" onClick={() => p.onCancelOrder(o)} disabled={p.busy}>Cancel</button></td>
                </tr>
              ))}
              {closed.map((o) => (
                <tr key={o.id} className="dim" title={o.reject_reason}>
                  <td>{o.side === "buy" ? "Buy" : "Sell"} {labelFor(o.symbol)}</td>
                  <td className="cap">{o.type.replace("_", " ")}</td>
                  <td className="num">{qty(o.quantity)}</td>
                  <td className="num">{o.stop_price ? price(o.stop_price) : "–"}</td>
                  <td className="num">{o.limit_price ? price(o.limit_price) : "–"}</td>
                  <td className={o.status === "rejected" ? "down" : ""}>{o.status === "rejected" ? `Rejected${o.reject_reason ? `: ${o.reject_reason}` : ""}` : "Cancelled"}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        ))}

        {p.tab === "history" && (
          <div className="history">
            <div className="history-side">
              <Sparkline points={p.paper?.equity_history ?? []} height={64} />
              <dl className="facts">
                <div><dt>Realized</dt><dd className={`num ${tone(p.paper?.realized_pnl)}`}>{signedMoney(p.paper?.realized_pnl)}</dd></div>
                <div><dt>Fees paid</dt><dd className="num">{money(p.paper?.fees_paid)}</dd></div>
              </dl>
            </div>
            {trades.length === 0 ? <Empty text="No fills yet" /> : (
              <table className="table">
                <thead><tr><th>Time</th><th>Fill</th><th>Price</th><th>Reason</th><th className="r">P&L</th></tr></thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id}>
                      <td className="num muted">{time(t.timestamp)}</td>
                      <td><b className={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "Buy" : "Sell"}</b> {qty(t.quantity)} {labelFor(t.symbol)}</td>
                      <td className="num">{price(t.price)}</td>
                      <td className="muted cap">{t.reason}</td>
                      <td className={`num r ${tone(t.realized_pnl)}`}>{t.realized_pnl ? signedMoney(t.realized_pnl) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {p.tab === "activity" && (p.logs.length === 0 ? <Empty text="Nothing yet" /> : (
          <ul className="log">
            {p.logs.slice().reverse().map((l, i) => <li key={`${l.timestamp}-${i}`}><time className="num">{l.timestamp}</time><span>{l.event}</span></li>)}
          </ul>
        ))}

        {p.tab === "assistant" && <Chat {...p} />}
      </div>
    </section>
  );
}

function Chat({ chat, onSendChat, chatPending, aiConfigured, strategyName }: Props) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.length, chatPending]);
  return (
    <div className="chat">
      <div className="chat-log">
        {chat.length === 0 && <p className="empty">Ask about your strategy, a market or your account. The assistant sees the chart, your strategy and your paper positions.</p>}
        {chat.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.text}</div>)}
        {chatPending && <div className="bubble assistant typing"><i /><i /><i /></div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSendChat(text.trim()); setText(""); } }}>
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} disabled={!aiConfigured}
          placeholder={aiConfigured ? `Ask about ${strategyName || "your strategy"}` : "Connect an AI provider in Settings to use the assistant"} />
        <button className="btn primary" disabled={!aiConfigured || !text.trim() || chatPending}>Send</button>
      </form>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
