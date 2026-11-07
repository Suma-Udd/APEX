import { useEffect, useRef, useState } from "react";
import type { LogItem, Order, PaperState, Position } from "../types";
import { labelFor } from "../constants";
import { money, price, qty, signedMoney, time, tone } from "../format";
import Sparkline from "./Sparkline";

type ChatMsg = { role: "user" | "assistant"; text: string };
type Props = {
  paper: PaperState | null; logs: LogItem[]; busy: boolean;
  onSelectSymbol: (api: string) => void; onClosePosition: (p: Position) => void; onCancelOrder: (o: Order) => void; onCloseAll: () => void;
  chat: ChatMsg[]; onSendChat: (text: string) => void; chatPending: boolean; aiConfigured: boolean; strategyName: string;
};

type Tab = "positions" | "orders" | "history" | "log" | "ai";

export default function SidePanel(p: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const positions = p.paper?.positions ?? [];
  const open = (p.paper?.orders ?? []).filter((o) => o.status === "pending" || o.status === "triggered");
  const recentClosed = (p.paper?.orders ?? []).filter((o) => o.status === "rejected" || o.status === "cancelled").slice(-8).reverse();
  const trades = (p.paper?.trades ?? []).slice(-60).reverse();

  return (
    <div className="side">
      <nav className="tabs">
        <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>Positions <b>{positions.length || ""}</b></button>
        <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>Orders <b>{open.length || ""}</b></button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
        <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Log</button>
        <button className={tab === "ai" ? "on" : ""} onClick={() => setTab("ai")}>AI</button>
      </nav>

      {tab === "positions" && (
        <div className="list">
          {positions.length === 0 && <Empty text="No open positions" />}
          {positions.map((pos) => (
            <div className="item" key={pos.id}>
              <button className="item-main" onClick={() => p.onSelectSymbol(pos.symbol)}>
                <div className="row-between">
                  <b>{labelFor(pos.symbol)} <span className={`side-tag ${pos.quantity > 0 ? "long" : "short"}`}>{pos.quantity > 0 ? "Long" : "Short"}</span></b>
                  <b className={`mono ${tone(pos.unrealized_pnl)}`}>{signedMoney(pos.unrealized_pnl)}</b>
                </div>
                <small>{qty(Math.abs(pos.quantity))} @ {price(pos.avg_price)} · now {price(pos.quantity > 0 ? pos.bid ?? pos.mark_price : pos.ask ?? pos.mark_price)} · margin {money(pos.margin)}</small>
                {(pos.stop_loss || pos.take_profit) && <small>SL {pos.stop_loss ? price(pos.stop_loss) : "–"} · TP {pos.take_profit ? price(pos.take_profit) : "–"}</small>}
              </button>
              <button className="btn btn-ghost sm" onClick={() => p.onClosePosition(pos)} disabled={p.busy}>Close</button>
            </div>
          ))}
          {positions.length > 0 && <button className="btn btn-danger-ghost block" onClick={p.onCloseAll} disabled={p.busy}>Close all positions</button>}
        </div>
      )}

      {tab === "orders" && (
        <div className="list">
          {open.length === 0 && <Empty text="No working orders" />}
          {open.map((o) => (
            <div className="item" key={o.id}>
              <div className="item-main static">
                <b>{o.side === "buy" ? "Buy" : "Sell"} {labelFor(o.symbol)}</b>
                <small>{o.type.replace("_", " ")} · {qty(o.quantity)}{o.stop_price ? ` · stop ${price(o.stop_price)}` : ""}{o.limit_price ? ` · limit ${price(o.limit_price)}` : ""}{o.status === "triggered" ? " · triggered" : ""}</small>
              </div>
              <button className="btn btn-ghost sm" onClick={() => p.onCancelOrder(o)} disabled={p.busy}>Cancel</button>
            </div>
          ))}
          {recentClosed.length > 0 && <div className="list-label">Recently cancelled or rejected</div>}
          {recentClosed.map((o) => (
            <div className="item compact" key={o.id}>
              <div className="item-main static">
                <div className="row-between"><b className="muted">{o.side === "buy" ? "Buy" : "Sell"} {qty(o.quantity)} {labelFor(o.symbol)}</b><small className={o.status === "rejected" ? "down" : "muted"}>{o.status}</small></div>
                {o.reject_reason && <small>{o.reject_reason}</small>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="list">
          <div className="account-curve"><div className="list-label">Account equity</div><Sparkline points={p.paper?.equity_history ?? []} height={48} /></div>
          <div className="summary">
            <div><span>Realized</span><b className={tone(p.paper?.realized_pnl)}>{signedMoney(p.paper?.realized_pnl)}</b></div>
            <div><span>Fees paid</span><b>{money(p.paper?.fees_paid)}</b></div>
          </div>
          {trades.length === 0 && <Empty text="No fills yet" />}
          {trades.map((t) => (
            <div className="item compact" key={t.id}>
              <div className="item-main static">
                <div className="row-between">
                  <b><span className={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "Buy" : "Sell"}</span> {qty(t.quantity)} {labelFor(t.symbol)}</b>
                  {t.realized_pnl ? <b className={`mono ${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</b> : null}
                </div>
                <small>@ {price(t.price)} · {t.reason} · {time(t.timestamp)}</small>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "log" && (
        <div className="list log">
          {p.logs.length === 0 && <Empty text="Log is empty" />}
          {p.logs.slice().reverse().map((l, i) => <div className="log-row" key={`${l.timestamp}-${i}`}><time>{l.timestamp}</time><span>{l.event}</span></div>)}
        </div>
      )}

      {tab === "ai" && <Chat {...p} />}
    </div>
  );
}

function Chat({ chat, onSendChat, chatPending, aiConfigured, strategyName }: Props) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.length, chatPending]);
  return (
    <div className="chat">
      <div className="chat-log">
        {chat.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.text}</div>)}
        {chatPending && <div className="bubble assistant typing">Thinking…</div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSendChat(text.trim()); setText(""); } }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} disabled={!aiConfigured}
          placeholder={aiConfigured ? `Ask about ${strategyName || "your strategy"}` : "Connect an AI provider in Settings"} />
        <button className="btn btn-primary" disabled={!aiConfigured || !text.trim() || chatPending}>Send</button>
      </form>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
