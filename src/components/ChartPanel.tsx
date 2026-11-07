import { useMemo, useState } from "react";
import PriceChart, { Guide } from "./PriceChart";
import { FRAMES, Instrument } from "../lib/constants";
import type { Candle, Quote } from "../lib/types";
import { pct, price, tone } from "../lib/format";
import { External } from "./Icons";

type Props = {
  instrument: Instrument; frame: string; onFrame: (api: string) => void;
  quote: Quote | null; quoteError: string; candles: Candle[]; candlesError: string; candlesLoading: boolean;
  emas: { period: number; color: string }[]; guides: Guide[]; theme: string;
  onGuideDrag: (key: string, p: number) => void; onGuideDrop: (key: string, p: number) => void;
};

function tradingViewUrl(symbol: string, interval: string, theme: string) {
  const params = new URLSearchParams({ symbol, interval, theme, style: "1", timezone: "Etc/UTC", withdateranges: "1", hide_side_toolbar: "0", allow_symbol_change: "0", saveimage: "0", hideideas: "1", details: "0", calendar: "0", hotlist: "0" });
  return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

export default function ChartPanel(p: Props) {
  const [view, setView] = useState<"apex" | "tv">("apex");
  const tvFrame = FRAMES.find((f) => f.api === p.frame)?.tv ?? "60";
  const tvUrl = useMemo(() => tradingViewUrl(p.instrument.tv, tvFrame, p.theme), [p.instrument.tv, tvFrame, p.theme]);
  const q = p.quote;
  const s = q?.session;
  const change = q ? q.price - q.price / (1 + q.change_pct / 100) : 0;

  return (
    <section className="chart-panel">
      <div className="chart-head">
        <div className="quote-block">
          <p className="meta">
            {p.instrument.name !== p.instrument.label && <>{p.instrument.name} · </>}{p.instrument.label}
            {s && <span className={`session ${s.open ? "open" : ""}`} title={s.hours}>{s.open ? "Market open" : `Closed${s.next_open ? `, opens ${when(s.next_open)}` : ""}`}</span>}
            {q?.delayed && <span className="muted" title={q.source}>Delayed</span>}
          </p>
          {q ? (
            <p className="last">
              <span className="num">{price(q.price)}</span>
              <span className={`num change ${tone(q.change_pct)}`}>{change > 0 ? "+" : ""}{price(change)} ({pct(q.change_pct)})</span>
            </p>
          ) : (
            <p className="last"><span className={p.quoteError ? "down small" : "muted small"}>{p.quoteError || "Loading…"}</span></p>
          )}
        </div>
        <div className="chart-tools">
          <div className="seg" role="tablist" aria-label="Timeframe">
            {FRAMES.map((f) => <button key={f.api} role="tab" aria-selected={p.frame === f.api} className={p.frame === f.api ? "on" : ""} onClick={() => p.onFrame(f.api)}>{f.label}</button>)}
          </div>
          <div className="seg" role="tablist" aria-label="Chart type">
            <button role="tab" aria-selected={view === "apex"} className={view === "apex" ? "on" : ""} onClick={() => setView("apex")} title="Your trades, draggable stop and target">Chart</button>
            <button role="tab" aria-selected={view === "tv"} className={view === "tv" ? "on" : ""} onClick={() => setView("tv")} title="TradingView, view only">TradingView</button>
          </div>
          <button className="icon-btn" title="Open in TradingView" aria-label="Open in TradingView"
            onClick={() => window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(p.instrument.tv)}`, "_blank", "noopener,noreferrer")}><External size={15} /></button>
        </div>
      </div>
      <div className="chart-area">
        {view === "apex" ? (
          <PriceChart candles={p.candles} emas={p.emas} guides={p.guides} onGuideDrag={p.onGuideDrag} onGuideDrop={p.onGuideDrop}
            loading={p.candlesLoading} error={p.candlesError} theme={p.theme} />
        ) : (
          <iframe key={tvUrl} title="TradingView chart" src={tvUrl} className="tv-frame" allow="fullscreen" />
        )}
      </div>
    </section>
  );
}
