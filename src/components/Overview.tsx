import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries, IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, LineSeries, LineStyle, SeriesMarker, Time,
  UTCTimestamp, createChart, createSeriesMarkers,
} from "lightweight-charts";
import { api } from "../lib/api";
import { labelFor } from "../lib/constants";
import { errText, money, pct, price, signedMoney } from "../lib/format";
import type { Candle } from "../lib/types";
import { chartOptions, palette } from "./PriceChart";
import { Tween } from "./Motion";
import { Close, Pause, Play } from "./Icons";

type Step = { title: string; text: string };
type Lesson = {
  side: "long" | "short"; entry_bar: number; exit_bar: number; signal_bar: number; entry: number; exit: number;
  stop: number | null; take_profit: number | null; pnl: number; r: number | null; bars: number; exit_reason: string;
  win: boolean; signal: string; readings: Record<string, number>; steps: Step[];
};
type OverviewData = {
  strategy: { id: string; name: string; category: string; description: string; entry: string[]; exit: string[] };
  symbol: string; timeframe: string; risk_pct: number; candles: Candle[];
  overlays: { key: string; label: string; points: [number, number][] }[];
  lessons: Lesson[]; equity_curve: [number, number][]; summary: string[];
  stats: { trades: number; wins: number; losses: number; win_rate_pct: number; net_pnl: number; return_pct: number; max_drawdown_pct: number; profit_factor: number | null; starting_balance: number };
};

type Props = { symbol: string; timeframe: string; strategyId: string; aiConfigured: boolean; theme: string; onClose: () => void };

const OVERLAY_COLORS = ["#0a84ff", "#ff9f0a", "#bf5af2", "#64d2ff", "#ffd60a", "#ac8e68"];
const SPEEDS = [1, 2, 4, 8];
const BARS_PER_SEC = 7;

/** Start with enough history on screen to read the trend, but before the first trade. */
const startBar = (d: OverviewData) => Math.max(0, Math.min(60, d.candles.length - 1, (d.lessons[0]?.signal_bar ?? 60) - 6));

/** Where the replay stands relative to a trade. */
function phaseOf(l: Lesson | null, cursor: number) {
  if (!l) return 0;
  if (cursor < l.signal_bar) return 0;
  if (cursor < l.entry_bar) return 1;   // signal fired: Why
  if (cursor < l.exit_bar) return 2;    // in the trade: + Plan
  return 4;                              // closed: + Result, Takeaway
}

export default function Overview({ symbol, timeframe, strategyId, aiConfigured, theme, onClose }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"intro" | "replay" | "done">("intro");
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [stopAtTrades, setStopAtTrades] = useState(true);
  const [closing, setClosing] = useState(false);
  const [ai, setAi] = useState<Record<number, string>>({});
  const [aiBusy, setAiBusy] = useState(false);
  // The trade the replay paused on. Needed when one trade closes on the same candle the next one signals.
  const [focus, setFocus] = useState<number | null>(null);
  const cursorF = useRef(0);
  const toggleRef = useRef<() => void>(() => undefined);
  const stopped = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api<OverviewData>("/api/overview", { method: "POST", body: JSON.stringify({ strategy_id: strategyId, symbol, timeframe }) })
      .then((d) => { if (alive) { setData(d); const c = startBar(d); setCursor(c); cursorF.current = c; } })
      .catch((e) => alive && setError(errText(e)));
    return () => { alive = false; };
  }, [strategyId, symbol, timeframe]);

  const close = useCallback(() => { setClosing(true); window.setTimeout(onClose, 220); }, [onClose]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === " " && stage !== "intro" && (e.target as HTMLElement)?.tagName !== "INPUT") { e.preventDefault(); toggleRef.current(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [close, stage]);

  const last = data ? data.candles.length - 1 : 0;
  const lessons = data?.lessons ?? [];

  // The lesson on screen: the latest trade whose signal has fired.
  const current = useMemo(() => {
    if (focus !== null) return focus;
    let idx = -1;
    lessons.forEach((l, i) => { if (l.signal_bar <= cursor) idx = i; });
    return idx;
  }, [lessons, cursor, focus]);
  const lesson = current >= 0 ? lessons[current] : null;
  const phase = phaseOf(lesson, cursor);

  // Playback clock.
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0, prev = performance.now();
    const loop = (now: number) => {
      const dt = (now - prev) / 1000; prev = now;
      let next = cursorF.current + dt * BARS_PER_SEC * speed;
      if (stopAtTrades) {
        // Exits come before signals on the same candle, so a trade's result shows before the next one starts.
        let hit: { bar: number; id: string; i: number; order: number } | null = null;
        lessons.forEach((l, i) => {
          for (const [bar, tag, order] of [[l.exit_bar, "x", 0], [l.signal_bar, "s", 1]] as const) {
            const id = `${tag}${i}`;
            if (cursorF.current < bar && next >= bar && !stopped.current.has(id) && (!hit || bar < hit.bar || (bar === hit.bar && order < hit.order))) hit = { bar, id, i, order };
          }
        });
        if (hit) {
          const h = hit as { bar: number; id: string; i: number };
          stopped.current.add(h.id);
          cursorF.current = h.bar; setCursor(h.bar); setFocus(h.i); setPlaying(false);
          return;
        }
      }
      if (next >= last) { cursorF.current = last; setCursor(last); setPlaying(false); setStage("done"); return; }
      cursorF.current = next;
      const whole = Math.floor(next);
      setCursor((c) => (c === whole ? c : whole));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, stopAtTrades, lessons, last, data]);

  const seek = (bar: number) => {
    setFocus(null);
    const b = Math.max(0, Math.min(last, Math.round(bar)));
    cursorF.current = b; setCursor(b);
    if (stage === "done" && b < last) setStage("replay");
  };
  const jump = (dir: 1 | -1) => {
    if (!lessons.length) return;
    const target = dir > 0 ? lessons.find((l) => l.signal_bar > cursor) : [...lessons].reverse().find((l) => l.signal_bar < (lesson && cursor === lesson.signal_bar ? cursor : cursor + 1) - (dir < 0 && lesson ? 1 : 0));
    if (target) { stopped.current.add(`s${lessons.indexOf(target)}`); setPlaying(false); seek(target.signal_bar); }
    else if (dir > 0) seek(last);
  };
  const start = () => { setStage("replay"); setPlaying(true); };
  // Continue after a pause: first show a trade that signalled on this same candle, then resume.
  const resume = () => {
    const j = lessons.findIndex((l, i) => i !== current && l.signal_bar === cursor && !stopped.current.has(`s${i}`));
    if (stopAtTrades && j >= 0) { stopped.current.add(`s${j}`); setFocus(j); return; }
    setFocus(null); setPlaying(true);
  };
  const toggle = () => { if (playing) setPlaying(false); else resume(); };
  toggleRef.current = stage === "done" ? () => replayAgain() : toggle;
  const replayAgain = () => { stopped.current.clear(); if (data) seek(startBar(data)); setStage("replay"); setPlaying(true); };

  // Running account value at the cursor (closed trades only).
  const closed = lessons.filter((l) => l.exit_bar <= cursor);
  const runningPnl = closed.reduce((a, l) => a + l.pnl, 0);
  const wins = closed.filter((l) => l.win).length;

  const askAi = async () => {
    if (!lesson || !data) return;
    setAiBusy(true);
    try {
      const steps = lesson.steps.map((s) => `${s.title}: ${s.text}`).join("\n");
      const r = await api<{ reply: string }>("/api/chat", { method: "POST", body: JSON.stringify({
        message: `Explain this paper trade to a beginner in 3 short sentences. What did the strategy see, why was the stop there, and what should I learn?\n${steps}`,
        context: { symbol, timeframe, strategy_id: strategyId, paper_mode: true },
      }) });
      setAi((m) => ({ ...m, [current]: r.reply }));
    } catch (e) { setAi((m) => ({ ...m, [current]: `Couldn't reach the AI: ${errText(e)}` })); }
    finally { setAiBusy(false); }
  };

  return (
    <div className={`overview ${closing ? "closing" : ""}`} role="dialog" aria-modal="true" aria-label="AI Overview">
      <header className="ov-head">
        <div className="ov-title">
          <span className="ov-kicker">AI Overview</span>
          <h2>{data ? data.strategy.name : "Preparing the replay"}</h2>
          <span className="muted">{labelFor(symbol)} · {timeframe}{data ? ` · last ${data.candles.length} candles` : ""}</span>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close"><Close size={16} /></button>
      </header>

      {!data && !error && <Loading />}
      {error && <div className="ov-error"><p>{error}</p><button className="btn" onClick={close}>Close</button></div>}

      {data && (
        <div className="ov-body">
          <section className="ov-stage">
            <ReplayChart data={data} cursor={cursor} lesson={stage === "intro" ? null : lesson} phase={phase} theme={theme} />
            <div className="ov-legend">
              {data.overlays.map((o, i) => <span key={o.key}><i style={{ background: OVERLAY_COLORS[i % OVERLAY_COLORS.length] }} />{o.label}</span>)}
              <span><i className="arrow up" />Entry</span><span><i className="dot-x" />Exit</span>
            </div>
            <Timeline data={data} cursor={cursor} onSeek={(b) => { setPlaying(false); seek(b); }} />
            <div className="ov-controls">
              <button className="icon-btn" onClick={() => jump(-1)} aria-label="Previous trade" title="Previous trade"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5 9 12l10 7V5Z" fill="currentColor" /></svg></button>
              <button className="play" onClick={() => (stage === "done" ? replayAgain() : stage === "intro" ? start() : toggle())} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button className="icon-btn" onClick={() => jump(1)} aria-label="Next trade" title="Next trade"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7V5Z" fill="currentColor" /></svg></button>
              <div className="seg" role="tablist" aria-label="Speed">
                {SPEEDS.map((s) => <button key={s} role="tab" aria-selected={speed === s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}×</button>)}
              </div>
              <label className="switch">
                <input type="checkbox" checked={stopAtTrades} onChange={(e) => setStopAtTrades(e.target.checked)} />
                <span className="track"><span className="knob" /></span>
                Pause at each trade
              </label>
              <div className="ov-running">
                <span>Trades <b className="num">{closed.length}</b></span>
                <span>Won <b className="num">{wins}</b></span>
                <span>P&L <b className={`num ${runningPnl > 0 ? "up" : runningPnl < 0 ? "down" : ""}`}><Tween value={runningPnl} format={signedMoney} /></b></span>
              </div>
            </div>
          </section>

          <aside className="ov-side">
            {stage === "intro" && <Intro data={data} onStart={start} />}
            {stage !== "intro" && stage !== "done" && (lesson
              ? <LessonCard key={current} lesson={lesson} index={current} total={lessons.length} phase={phase} riskPct={data.risk_pct}
                  ai={ai[current]} aiBusy={aiBusy} aiConfigured={aiConfigured} onAsk={() => void askAi()} onContinue={resume} playing={playing} />
              : <Waiting playing={playing} />)}
            {stage === "done" && <Summary data={data} onReplay={replayAgain} onClose={close} />}
          </aside>
        </div>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="ov-loading">
      <div className="ov-bars" aria-hidden="true">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 70}ms` }} />)}</div>
      <p>Replaying the strategy on recent history…</p>
    </div>
  );
}

function Intro({ data, onStart }: { data: OverviewData; onStart: () => void }) {
  const s = data.strategy;
  return (
    <div className="ov-card rise">
      <span className="ov-kicker">How this strategy thinks</span>
      <h3>{s.name}</h3>
      <p>{s.description}</p>
      <div className="ov-rules">
        <div><h4>Gets in when</h4>{s.entry.map((r, i) => <p key={i} style={{ animationDelay: `${120 + i * 80}ms` }}>{r}</p>)}</div>
        <div><h4>Gets out when</h4>{s.exit.map((r, i) => <p key={i} style={{ animationDelay: `${280 + i * 80}ms` }}>{r}</p>)}</div>
      </div>
      <p className="hint">The replay walks through the last {data.candles.length} candles. Every time the strategy acts, it stops and explains why. Each trade risks {data.risk_pct}% of the account.</p>
      <button className="btn primary block big" onClick={onStart}><Play size={13} /> Start replay</button>
      <p className="hint center">{data.lessons.length ? `${data.lessons.length} trades to walk through` : "No trades in this window. The replay still shows what the strategy watches."}</p>
    </div>
  );
}

function Waiting({ playing }: { playing: boolean }) {
  return (
    <div className="ov-card ov-wait rise">
      <div className="radar" aria-hidden="true"><i /><i /><i /></div>
      <h3>{playing ? "Watching the market" : "Paused"}</h3>
      <p className="muted">The strategy checks every candle as it closes. Nothing has lined up yet.</p>
    </div>
  );
}

function LessonCard({ lesson, index, total, phase, riskPct, ai, aiBusy, aiConfigured, onAsk, onContinue, playing }: {
  lesson: Lesson; index: number; total: number; phase: number; riskPct: number; ai?: string; aiBusy: boolean; aiConfigured: boolean;
  onAsk: () => void; onContinue: () => void; playing: boolean;
}) {
  const long = lesson.side === "long";
  const visible = phase >= 4 ? 4 : phase >= 2 ? 2 : 1;
  const fresh = visible === 4 ? 2 : visible - 1; // first step that just appeared, for staggering
  const status = phase >= 4 ? (lesson.win ? "Win" : "Loss") : phase >= 2 ? "Open" : "Signal";
  const r = lesson.r ?? 0;
  return (
    <div className="ov-card lesson rise">
      <div className="row-between">
        <span className="ov-kicker">Trade {index + 1} of {total}</span>
        <span className={`status ${status.toLowerCase()}`}>{status}</span>
      </div>
      <h3><span className={long ? "up" : "down"}>{long ? "Long" : "Short"}</span> <span className="muted">· {lesson.signal}</span></h3>
      {Object.keys(lesson.readings).length > 0 && (
        <div className="chips">{Object.entries(lesson.readings).map(([k, v]) => <span key={k} className="chip">{k} <b className="num">{v}</b></span>)}</div>
      )}
      <ol className="steps">
        {lesson.steps.slice(0, visible).map((s, i) => (
          <li key={s.title} className={`step ${i < fresh ? "past" : ""}`} title={i < fresh ? s.text : undefined} style={{ animationDelay: `${Math.max(0, i - fresh) * 160}ms` }}>
            <span className="step-dot">{i + 1}</span>
            <div><h4>{s.title}</h4><p>{s.text}</p></div>
          </li>
        ))}
      </ol>
      {phase >= 2 && (
        <dl className="facts three levels">
          <div><dt>Entry</dt><dd className="num">{price(lesson.entry)}</dd></div>
          <div><dt>Stop</dt><dd className="num down">{lesson.stop ? price(lesson.stop) : "–"}</dd></div>
          <div><dt>Target</dt><dd className="num up">{lesson.take_profit ? price(lesson.take_profit) : "Signal"}</dd></div>
        </dl>
      )}
      {phase >= 4 && (
        <div className="outcome">
          <div className="row-between"><span className="muted">Result</span><b className={`num ${lesson.win ? "up" : "down"}`}><Tween value={lesson.pnl} format={signedMoney} ms={700} /></b></div>
          <RMeter r={r} />
          <p className="hint">{lesson.r !== null ? `${r > 0 ? "+" : ""}${r.toFixed(1)}R: ${Math.abs(r).toFixed(1)}× the ${riskPct}% the trade risked.` : "Partial grid exit."}</p>
        </div>
      )}
      {ai && <p className="ai-note rise">{ai}</p>}
      <div className="row ov-actions">
        {!playing && <button className="btn primary" onClick={onContinue}>Continue</button>}
        {aiConfigured && !ai && <button className="btn" onClick={onAsk} disabled={aiBusy}>{aiBusy ? "Asking…" : "Ask AI to explain"}</button>}
      </div>
    </div>
  );
}

function RMeter({ r }: { r: number }) {
  // -3R .. +3R scale, zero in the middle.
  const clamp = Math.max(-3, Math.min(3, r));
  const w = (Math.abs(clamp) / 3) * 50;
  return (
    <div className="rmeter" aria-hidden="true">
      <span className="zero" />
      <i className={r >= 0 ? "pos" : "neg"} style={{ width: `${w}%`, left: r >= 0 ? "50%" : `${50 - w}%` }} />
    </div>
  );
}

function Summary({ data, onReplay, onClose }: { data: OverviewData; onReplay: () => void; onClose: () => void }) {
  const s = data.stats;
  return (
    <div className="ov-card rise">
      <span className="ov-kicker">What the replay showed</span>
      <h3 className={s.net_pnl >= 0 ? "up" : "down"}><Tween value={s.net_pnl} format={signedMoney} ms={900} /></h3>
      <p className="muted">{pct(s.return_pct)} on {money(s.starting_balance)} over {data.candles.length} candles</p>
      <dl className="facts grid">
        <div><dt>Trades</dt><dd className="num"><Tween value={s.trades} format={(n) => String(Math.round(n))} ms={700} /></dd></div>
        <div><dt>Win rate</dt><dd className="num"><Tween value={s.win_rate_pct} format={(n) => `${n.toFixed(0)}%`} ms={700} /></dd></div>
        <div><dt>Max drawdown</dt><dd className="num down">{s.max_drawdown_pct.toFixed(1)}%</dd></div>
        <div><dt>Profit factor</dt><dd className="num">{s.profit_factor ?? "–"}</dd></div>
      </dl>
      <ul className="lessons">{data.summary.map((t, i) => <li key={i} style={{ animationDelay: `${200 + i * 120}ms` }}>{t}</li>)}</ul>
      <p className="hint">Simulated on past data with spreads and fees. It teaches how the strategy behaves, it doesn't predict what comes next.</p>
      <div className="row"><button className="btn primary" onClick={onReplay}>Watch again</button><button className="btn" onClick={onClose}>Back to trading</button></div>
    </div>
  );
}

function Timeline({ data, cursor, onSeek }: { data: OverviewData; cursor: number; onSeek: (b: number) => void }) {
  const last = data.candles.length - 1;
  const pos = (b: number) => `${(b / last) * 100}%`;
  return (
    <div className="ov-timeline">
      <div className="ov-track">
        {data.lessons.map((l, i) => (
          <span key={i} className={`seg-trade ${l.win ? "win" : "loss"} ${l.signal_bar <= cursor ? "seen" : ""}`}
            style={{ left: pos(l.entry_bar), width: `max(3px, ${((l.exit_bar - l.entry_bar) / last) * 100}%)` }} />
        ))}
        <span className="ov-progress" style={{ width: pos(cursor) }} />
      </div>
      <span className="ov-head-dot" style={{ left: pos(cursor) }} />
      <input type="range" min={0} max={last} value={cursor} onChange={(e) => onSeek(Number(e.target.value))} aria-label="Replay position" />
    </div>
  );
}

function ReplayChart({ data, cursor, lesson, phase, theme }: { data: OverviewData; cursor: number; lesson: Lesson | null; phase: number; theme: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<ISeriesApi<"Line">[]>([]);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const levels = useRef<IPriceLine[]>([]);
  const shown = useRef(-1);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, { autoSize: true, ...chartOptions(), handleScroll: false, handleScale: false });
    const col = palette();
    candles.current = c.addSeries(CandlestickSeries, { upColor: col.up, downColor: col.down, wickUpColor: col.up, wickDownColor: col.down, borderVisible: false, priceFormat: { type: "custom", formatter: (p: number) => price(p), minMove: 0.00001 } });
    lines.current = data.overlays.map((_, i) => c.addSeries(LineSeries, { color: OVERLAY_COLORS[i % OVERLAY_COLORS.length], lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
    markers.current = createSeriesMarkers(candles.current, []);
    chart.current = c;
    shown.current = -1;
    return () => { c.remove(); chart.current = null; candles.current = null; lines.current = []; markers.current = null; levels.current = []; };
  }, [data]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.applyOptions({ ...chartOptions(), handleScroll: false, handleScale: false });
    const { up, down } = palette();
    candles.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }, [theme]);

  // Reveal candles up to the cursor: append while moving forward, rebuild when seeking back.
  useEffect(() => {
    const s = candles.current, c = chart.current;
    if (!s || !c) return;
    const bars = data.candles;
    const toBar = (k: Candle) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c });
    if (cursor < shown.current || shown.current < 0 || cursor - shown.current > 40) {
      s.setData(bars.slice(0, cursor + 1).map(toBar));
      data.overlays.forEach((o, i) => lines.current[i]?.setData(o.points.filter(([b]) => b <= cursor).map(([b, v]) => ({ time: bars[b].t as UTCTimestamp, value: v }))));
    } else {
      for (let b = shown.current + 1; b <= cursor; b++) {
        s.update(toBar(bars[b]));
        data.overlays.forEach((o, i) => {
          const p = o.points.find(([x]) => x === b);
          if (p) lines.current[i]?.update({ time: bars[b].t as UTCTimestamp, value: p[1] });
        });
      }
    }
    shown.current = cursor;
    // Camera follows the newest candle.
    const span = 110;
    c.timeScale().setVisibleLogicalRange({ from: Math.max(-4, cursor - span), to: Math.max(cursor + 8, span * 0.6) });

    // Entry / exit markers for everything the replay has reached.
    const { up, down, text } = palette();
    const ms: SeriesMarker<Time>[] = [];
    for (const l of data.lessons) {
      if (l.entry_bar <= cursor) ms.push({ time: bars[l.entry_bar].t as UTCTimestamp, position: l.side === "long" ? "belowBar" : "aboveBar", shape: l.side === "long" ? "arrowUp" : "arrowDown", color: l.side === "long" ? up : down, text: l.side === "long" ? "Buy" : "Sell" });
      if (l.exit_bar <= cursor) ms.push({ time: bars[l.exit_bar].t as UTCTimestamp, position: l.side === "long" ? "aboveBar" : "belowBar", shape: "circle", color: l.win ? up : text, text: l.win ? `+${l.r ?? ""}R`.replace("+R", "Win") : `${l.r ?? ""}R`.replace(/^R$/, "Exit") });
    }
    ms.sort((a, b) => (a.time as number) - (b.time as number));
    markers.current?.setMarkers(ms);
  }, [cursor, data]);

  // Entry, stop and target lines for the trade on screen.
  useEffect(() => {
    const s = candles.current;
    if (!s) return;
    levels.current.forEach((l) => s.removePriceLine(l));
    levels.current = [];
    if (!lesson || phase < 1 || phase >= 4) return;
    const { up, down, text } = palette();
    const add = (p: number | null, color: string, title: string, style = LineStyle.Dashed) => {
      if (p) levels.current.push(s.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    if (phase >= 2) add(lesson.entry, text, "Entry", LineStyle.Solid);
    add(lesson.stop, down, "Stop");
    add(lesson.take_profit, up, "Target");
  }, [lesson, phase]);

  return (
    <div className="ov-chart">
      <div ref={box} className="ov-chart-canvas" />
      {lesson && phase === 1 && <div className="ov-flash" key={lesson.signal_bar}>Signal</div>}
    </div>
  );
}
