import { useMemo, useState } from "react";
import PriceChart, { Guide } from "./PriceChart";
import { FRAMES, Instrument, SYMBOLS } from "../constants";
import type { Candle, Quote } from "../types";
import { pct, price, tone } from "../format";
import Flash from "./Flash";

type Props = {
  instrument: Instrument; onSymbol: (api: string) => void; frame: string; onFrame: (api: string) => void;
  quote: Quote | null; quoteError: string; candles: Candle[]; candlesError: string; candlesLoading: boolean;
  emas: { period: number; color: string }[]; guides: Guide[];
  onGuideDrag: (key: string, p: number) => void; onGuideDrop: (key: string, p: number) => void;
};

function tradingViewUrl(symbol: string, interval: string) {
  const params = new URLSearchParams({ symbol, interval, theme: "dark", style: "1", timezone: "Etc/UTC", withdateranges: "1", hide_side_toolbar: "0", allow_symbol_change: "0", saveimage: "0", hideideas: "1", details: "0", calendar: "0", hotlist: "0" });
  return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
}

export default function ChartPanel(p: Props) {
  const [view, setView] = useState<"apex" | "tv">("apex");
  const tvFrame = FRAMES.find((f) => f.api === p.frame)?.tv ?? "60";
  const tvUrl = useMemo(() => tradingViewUrl(p.instrument.tv, tvFrame), [p.instrument.tv, tvFrame]);
  const markets = Array.from(new Set(SYMBOLS.map((s) => s.market)));

  return (
    <section className="chart-panel">
      <div className="chart-bar">
        <select className="input symbol-select" value={p.instrument.api} onChange={(e) => p.onSymbol(e.target.value)}>
          {markets.map((m) => <optgroup key={m} label={m}>{SYMBOLS.filter((s) => s.market === m).map((s) => <option key={s.api} value={s.api}>{s.label}</option>)}</optgroup>)}
        </select>
        <div className="quote">
          {p.quote ? (
            <>
              <b className="mono"><Flash value={p.quote.price}>{price(p.quote.price)}</Flash></b>
              <span className={`mono ${tone(p.quote.change_pct)}`}>{pct(p.quote.change_pct)}</span>
              <span className="ba mono" title="Bid / ask">{price(p.quote.bid)} / {price(p.quote.ask)}</span>
              {p.quote.delayed && <span className="chip" title={p.quote.source}>delayed</span>}
              {p.quote.session && (p.quote.session.open
                ? <span className="session open" title={p.quote.session.hours}>Open · {p.quote.session.leverage}:1</span>
                : <span className="session closed" title={p.quote.session.hours}>Closed{p.quote.session.next_open ? ` · opens ${new Date(p.quote.session.next_open).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</span>)}
            </>
          ) : <span className={p.quoteError ? "down" : "muted"}>{p.quoteError || "Loading price…"}</span>}
        </div>
        <div className="frames">
          {FRAMES.map((f) => <button key={f.api} className={p.frame === f.api ? "on" : ""} onClick={() => p.onFrame(f.api)}>{f.label}</button>)}
        </div>
        <div className="segmented small">
          <button className={view === "apex" ? "on" : ""} onClick={() => setView("apex")} title="Chart with your trades and draggable stop/target">Chart</button>
          <button className={view === "tv" ? "on" : ""} onClick={() => setView("tv")} title="TradingView widget, view only">TradingView</button>
        </div>
        <button className="btn btn-icon" title="Open in TradingView in your browser" onClick={() => window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(p.instrument.tv)}`, "_blank", "noopener,noreferrer")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button>
      </div>
      <div className="chart-area">
        {view === "apex" ? (
          <PriceChart candles={p.candles} emas={p.emas} guides={p.guides} onGuideDrag={p.onGuideDrag} onGuideDrop={p.onGuideDrop}
            loading={p.candlesLoading} error={p.candlesError} />
        ) : (
          <iframe key={tvUrl} title="TradingView chart" src={tvUrl} className="tv-frame" allow="fullscreen" />
        )}
      </div>
      {view === "tv" && <p className="chart-foot">TradingView is view-only here. Switch to Chart to see your positions and drag stop/target lines.</p>}
    </section>
  );
}
