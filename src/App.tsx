import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isMac, useBackendStatus, usePoll } from "./lib/api";
import { SYMBOLS, findSymbol, labelFor } from "./lib/constants";
import { errText, price as fmtPrice, signedMoney } from "./lib/format";
import { useTheme } from "./lib/theme";
import { useUpdater } from "./lib/updater";
import { useLivePrices } from "./lib/live";
import type {
  AISettings, AISetup, Backtest, Candle, Health, LogItem, MiniQuote, OperationMode, Order, PaperState, Position, Quote, Risk,
  Strategy, StrategyResponse,
} from "./lib/types";
import Toolbar from "./components/Toolbar";
import Watchlist from "./components/Watchlist";
import ChartPanel from "./components/ChartPanel";
import BottomPanel, { BottomTab } from "./components/BottomPanel";
import OrderTicket, { TicketState } from "./components/OrderTicket";
import StrategyPanel from "./components/StrategyPanel";
import RiskPanel from "./components/RiskPanel";
import SettingsModal from "./components/SettingsModal";
import Startup from "./components/Startup";
import Toasts, { Toast } from "./components/Toasts";
import UpdateCard from "./components/UpdateCard";
import type { Guide, Marker } from "./components/PriceChart";
import Overview from "./components/Overview";
import { Alert } from "./components/Icons";

const DEFAULT_RISK: Risk = { risk_pct: 0.5, max_drawdown_pct: 5, max_open_positions: 3, daily_loss_limit_pct: 2 };
const EMPTY_TICKET: TicketState = { side: "buy", type: "market", qty: "1", limit: "", stop: "", sl: "", tp: "" };
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const WATCH = SYMBOLS.map((s) => s.api).join(",");
const CRYPTO = SYMBOLS.filter((s) => s.market === "Crypto").map((s) => s.api);
const STEP: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };

function stored<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export default function App() {
  const [backend, restartBackend] = useBackendStatus();
  const ready = backend.phase === "ready";
  const [themePref, setThemePref, theme] = useTheme();

  // ── Live data (polled) ────────────────────────────────────────────────
  const [health, setHealth] = useState<Health | null>(null);
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [watch, setWatch] = useState<Record<string, MiniQuote>>({});
  const [offline, setOffline] = useState(false);

  // ── Config (loaded once and after explicit saves, never clobbered by polling) ──
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyId, setStrategyId] = useState("trend-following-ema");
  const [savedParams, setSavedParams] = useState<Record<string, number>>({});
  const [params, setParams] = useState<Record<string, number>>({});
  const [paramStatus, setParamStatus] = useState("Saved");
  const [savedRisk, setSavedRisk] = useState<Risk>(DEFAULT_RISK);
  const [risk, setRisk] = useState<Risk>(DEFAULT_RISK);
  const [, setRiskStatus] = useState("Saved");
  const [aiSettings, setAiSettings] = useState<AISettings>({ base_url: "http://127.0.0.1:31415/v1", model: "auto", api_key_set: false });
  const [mode, setMode] = useState<OperationMode>("manual");
  const [aiSetup, setAiSetup] = useState<AISetup | null>(null);

  // ── Chart / market ────────────────────────────────────────────────────
  const [symbol, setSymbolRaw] = useState<string>(() => stored("apex.symbol", "BTCUSDT"));
  const [frame, setFrameRaw] = useState<string>(() => stored("apex.frame", "1h"));
  const setSymbol = (s: string) => { setSymbolRaw(s); store("apex.symbol", s); };
  const setFrame = (f: string) => { setFrameRaw(f); store("apex.frame", f); };
  const [polledQuote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesError, setCandlesError] = useState("");
  const [candlesLoading, setCandlesLoading] = useState(false);

  // ── UI ────────────────────────────────────────────────────────────────
  const [inspector, setInspector] = useState<"trade" | "strategy" | "risk">("trade");
  const [bottomTab, setBottomTab] = useState<BottomTab>("positions");
  const [sidebar, setSidebar] = useState(() => stored("apex.sidebar", "1") === "1");
  const [ticket, setTicket] = useState<TicketState>(EMPTY_TICKET);
  const [orderMessage, setOrderMessage] = useState("");
  const [modeMessage, setModeMessage] = useState("");
  const [backtest, setBacktest] = useState<Backtest | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [chat, setChat] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [chatPending, setChatPending] = useState(false);
  const [dragLevels, setDragLevels] = useState<{ sl?: number; tp?: number }>({});
  const [overview, setOverview] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const updater = useUpdater();

  const instrument = findSymbol(symbol) ?? SYMBOLS[4];
  const strategy = strategies.find((s) => s.id === strategyId) ?? null;
  const position = paper?.positions.find((p) => p.symbol === symbol) ?? null;

  useEffect(() => { document.documentElement.classList.toggle("mac", isMac); }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const [s, r, ai, m] = await Promise.all([
        api<StrategyResponse>("/api/strategies"), api<Risk>("/api/risk"), api<AISettings>("/api/ai/settings"),
        api<{ mode: OperationMode; setup: AISetup | null }>("/api/mode"),
      ]);
      setStrategies([...s.built_in, ...s.custom]);
      setSavedRisk(r); setRisk(r);
      setAiSettings(ai);
      setMode(m.mode); setAiSetup(m.setup);
    } catch (e) { toast(errText(e), "bad"); }
  }, [toast]);
  useEffect(() => { if (ready) void loadConfig(); }, [ready, loadConfig]);

  const pollPaper = useCallback(async () => {
    try {
      const p = await api<PaperState>("/api/paper/state");
      setPaper((old) => (sameJSON(old, p) ? old : p)); setOffline(false);
    } catch { setOffline(true); }
  }, []);
  usePoll(pollPaper, 2000, [], ready);
  usePoll(async () => { try { setHealth(await api<Health>("/api/health")); } catch { /* paper poll reports offline */ } }, 20000, [], ready);
  usePoll(async () => {
    const l = await api<LogItem[]>("/api/logs?limit=150");
    setLogs((old) => (sameJSON(old, l) ? old : l));
  }, 5000, [], ready && bottomTab === "activity");
  usePoll(async () => {
    const list = await api<MiniQuote[]>(`/api/market/quotes?symbols=${encodeURIComponent(WATCH)}`);
    setWatch(Object.fromEntries(list.map((q) => [q.symbol, q])));
  }, 10000, [], ready && sidebar);

  // Strategy parameters: load when the selected strategy changes (not every poll).
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api<{ parameters: Record<string, number> }>(`/api/strategies/${encodeURIComponent(strategyId)}/parameters`)
      .then((r) => { if (alive) { setSavedParams(r.parameters); setParams(r.parameters); setParamStatus("Saved"); } })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [strategyId, ready]);

  // Quote for the selected symbol.
  useEffect(() => { setQuote(null); setQuoteError(""); }, [symbol]);
  // Crypto streams tick by tick from Binance. Everything else polls the backend.
  const live = useLivePrices(CRYPTO, symbol, ready && !overview);
  const streaming = live.connected && CRYPTO.includes(symbol);
  usePoll(async () => {
    try { const q = await api<Quote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`); setQuote(q); setQuoteError(""); }
    catch (e) { setQuoteError(errText(e)); }
  }, streaming ? 5000 : 1500, [symbol, streaming], ready && !overview);
  const tick = live.connected ? live.ticks[symbol] : undefined;
  const quote: Quote | null = useMemo(() => {
    if (!polledQuote || polledQuote.symbol !== symbol || !tick?.price) return polledQuote;
    return { ...polledQuote, price: tick.price, bid: tick.bid ?? tick.price, ask: tick.ask ?? tick.price, change_pct: tick.change_pct ?? polledQuote.change_pct, delayed: false, source: "Binance live stream" };
  }, [polledQuote, tick, symbol]);
  const watchLive = useMemo(() => {
    if (!live.connected) return watch;
    const out = { ...watch };
    for (const [sym, t] of Object.entries(live.ticks)) if (out[sym] && t.price) out[sym] = { ...out[sym], price: t.price, change_pct: t.change_pct ?? out[sym].change_pct };
    return out;
  }, [watch, live]);

  // Candles for the chart.
  useEffect(() => { setCandles([]); setCandlesError(""); setCandlesLoading(true); }, [symbol, frame]);
  usePoll(async () => {
    try {
      const r = await api<{ candles: Candle[] }>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${frame}&limit=400`);
      setCandles((old) => (sameJSON(old, r.candles) ? old : r.candles)); setCandlesError("");
    } catch (e) { setCandlesError(errText(e)); }
    finally { setCandlesLoading(false); }
  }, 30000, [symbol, frame], ready);

  // Keep the last candle moving with the live quote between candle refreshes.
  const liveCandles = useMemo(() => {
    if (!candles.length || !quote || quote.symbol !== symbol) return candles;
    const last = candles[candles.length - 1];
    const step = STEP[frame] ?? 3600;
    const c = quote.price;
    const now = Date.now() / 1000;
    if (now >= last.t + step) {
      // A new candle opened since the last refresh. Start it locally while the market is trading.
      if (quote.session && !quote.session.open) return candles;
      if (now >= last.t + 2 * step) return candles;
      return [...candles, { t: last.t + step, o: last.c, h: Math.max(last.c, c), l: Math.min(last.c, c), c, v: 0 }];
    }
    if (c === last.c) return candles;
    return [...candles.slice(0, -1), { ...last, c, h: Math.max(last.h, c), l: Math.min(last.l, c) }];
  }, [candles, quote, symbol, frame]);

  // Fills happen in the backend; the UI just announces new ones.
  const seenTrades = useRef<Set<string> | null>(null);
  useEffect(() => {
    const trades = paper?.trades ?? [];
    if (seenTrades.current === null) { if (paper) seenTrades.current = new Set(trades.map((t) => t.id)); return; }
    for (const t of trades) {
      if (seenTrades.current.has(t.id)) continue;
      seenTrades.current.add(t.id);
      if (t.reason !== "market order" && !t.reason.startsWith("manual") && t.reason !== "close all") {
        toast(`${t.reason.charAt(0).toUpperCase()}${t.reason.slice(1)}: ${t.side === "buy" ? "Bought" : "Sold"} ${Number(t.quantity.toPrecision(6))} ${labelFor(t.symbol)} at ${fmtPrice(t.price)}`, t.realized_pnl && t.realized_pnl < 0 ? "bad" : "good");
      }
    }
  }, [paper, toast]);

  // Stops/targets/orders that filled while the app was closed get one summary on open.
  const reportId = paper?.catch_up_report?.id;
  useEffect(() => {
    const rep = paper?.catch_up_report;
    if (!rep) return;
    let seen = "";
    try { seen = localStorage.getItem("apex.catchUpSeen") || ""; } catch { /* storage off */ }
    if (seen === rep.id) return;
    try { localStorage.setItem("apex.catchUpSeen", rep.id); } catch { /* storage off */ }
    toast(`While APEX was closed: ${rep.count} order${rep.count === 1 ? "" : "s"} filled · ${signedMoney(rep.net)}`, rep.net < 0 ? "bad" : "good");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, toast]);

  // Reset drag preview once the real position levels come back.
  useEffect(() => { setDragLevels({}); }, [position?.stop_loss, position?.take_profit, symbol]);

  // ── Actions ───────────────────────────────────────────────────────────
  const run = async <T,>(fn: () => Promise<T>, onError?: (msg: string) => void): Promise<T | null> => {
    setBusy(true);
    try { return await fn(); }
    catch (e) { const m = errText(e); onError ? onError(m) : toast(m, "bad"); return null; }
    finally { setBusy(false); }
  };

  const generateSetup = async (): Promise<AISetup | null> => {
    setModeMessage("AI is reading the market…");
    const setup = await run(() => api<AISetup>("/api/ai/strategy-setup", { method: "POST", body: JSON.stringify({ symbol, timeframe: frame, strategy_id: strategyId }) }),
      (m) => setModeMessage(`AI setup failed: ${m}`));
    if (setup) {
      setAiSetup(setup); setStrategyId(setup.strategy_id); setParams(setup.parameters); setSavedParams(setup.parameters);
      setModeMessage(""); toast(`AI setup ready for ${setup.strategy_name}`, "good");
    }
    return setup;
  };

  const toggleEngine = async () => {
    if (paper?.active) {
      const next = await run(() => api<PaperState>("/api/paper/pause", { method: "POST" }));
      if (next) { setPaper(next); toast("Engine paused"); }
      return;
    }
    if (mode === "ai_auto" && (!aiSetup || aiSetup.symbol !== symbol)) {
      if (!(await generateSetup())) return;
    }
    const next = await run(() => api<PaperState>("/api/paper/start", { method: "POST" }));
    if (!next) return;
    setPaper(next); toast("Engine started", "good");
    if (mode === "ai_auto") {
      const step = await run(() => api<{ portfolio?: PaperState; signal: string; orders?: unknown[]; note?: string }>("/api/paper/strategy-step", { method: "POST" }), (m) => setModeMessage(m));
      if (step) { if (step.portfolio) setPaper(step.portfolio); setModeMessage(step.note ?? ""); }
    }
  };

  const changeMode = async (m: OperationMode) => {
    const r = await run(() => api<{ mode: OperationMode; setup: AISetup | null }>("/api/mode", { method: "POST", body: JSON.stringify({ mode: m }) }));
    if (!r) return;
    setMode(r.mode); setAiSetup(r.setup); setModeMessage("");
  };

  const saveParams = async () => {
    const r = await run(() => api<{ parameters: Record<string, number> }>(`/api/strategies/${encodeURIComponent(strategyId)}/parameters`, { method: "POST", body: JSON.stringify({ parameters: params }) }));
    if (r) { setSavedParams(r.parameters); setParams(r.parameters); setParamStatus("Saved"); toast("Parameters saved", "good"); }
  };

  const saveRisk = async () => {
    const r = await run(() => api<Risk>("/api/risk", { method: "POST", body: JSON.stringify(risk) }));
    if (r) { setSavedRisk(r); setRisk(r); setRiskStatus("Saved"); toast("Risk limits saved", "good"); void pollPaper(); }
  };

  const resetAccount = async () => {
    if (!window.confirm("Reset the paper account? All positions, orders and history get wiped and you start again with $100,000.")) return;
    const r = await run(() => api<PaperState>("/api/paper/reset", { method: "POST" }));
    if (r) { setPaper(r); toast("Account reset to $100,000", "good"); }
  };

  const duplicate = async (name: string) => {
    const created = await run(() => api<Strategy>("/api/strategies/custom", { method: "POST", body: JSON.stringify({ name, description: `My copy of ${strategy?.name ?? "an APEX strategy"}`, source_id: strategyId }) }));
    if (created) { await loadConfig(); setStrategyId(created.id); toast(`Created "${created.name}"`, "good"); }
  };

  const runBacktest = async () => {
    setBacktest(null);
    const r = await run(() => api<Backtest>("/api/backtest", { method: "POST", body: JSON.stringify({ strategy_id: strategyId, symbol, timeframe: frame, starting_balance: 10000 }) }),
      (m) => setBacktest({ error: m }));
    if (r) setBacktest(r);
  };

  const submitOrder = async (side: "buy" | "sell") => {
    setOrderMessage("");
    const n = (v: string) => (v.trim() ? Number(v) : null);
    const r = await run(() => api<{ order: Order; portfolio: PaperState }>("/api/paper/order", {
      method: "POST",
      body: JSON.stringify({ symbol, side, type: ticket.type, quantity: Number(ticket.qty), limit_price: n(ticket.limit), stop_price: n(ticket.stop), stop_loss: n(ticket.sl), take_profit: n(ticket.tp) }),
    }), (m) => setOrderMessage(m));
    if (!r) return;
    setPaper(r.portfolio);
    const verb = r.order.status === "filled" ? "Filled" : r.order.status === "triggered" ? "Triggered" : "Working";
    toast(`${verb}: ${side === "buy" ? "Buy" : "Sell"} ${ticket.qty} ${instrument.label}${r.order.filled_price ? ` at ${fmtPrice(r.order.filled_price)}` : ""}`, "good");
    setTicket((t) => ({ ...t, sl: "", tp: "", limit: "", stop: "" }));
  };

  const closePosition = async (p: Position) => {
    const r = await run(() => api<{ portfolio: PaperState; trade: { realized_pnl: number } }>(`/api/paper/positions/${encodeURIComponent(p.symbol)}/close`, { method: "POST" }));
    if (r) { setPaper(r.portfolio); toast(`Closed ${labelFor(p.symbol)} · ${signedMoney(r.trade.realized_pnl)}`, r.trade.realized_pnl >= 0 ? "good" : "bad"); }
  };

  const closeAll = async () => {
    if (!window.confirm("Close every paper position and cancel all working orders? The engine will pause too.")) return;
    const r = await run(() => api<PaperState>("/api/paper/close-all", { method: "POST" }));
    if (r) { setPaper(r); toast((r as PaperState & { skipped?: string[] }).skipped?.length ? `Closed. Market shut for ${(r as PaperState & { skipped?: string[] }).skipped!.map(labelFor).join(", ")}` : "All positions closed"); }
  };

  const cancelOrder = async (o: Order) => {
    const r = await run(() => api<Order>(`/api/paper/orders/${o.id}`, { method: "DELETE" }));
    if (r) { void pollPaper(); toast("Order cancelled"); }
  };

  const saveAI = async (s: { base_url: string; model: string; api_key: string }, test: boolean) => {
    setSettingsMessage("");
    await run(async () => {
      const saved = await api<AISettings>("/api/ai/settings", { method: "POST", body: JSON.stringify(s) });
      setAiSettings(saved);
      if (test) {
        const t = await api<{ models: string[] }>("/api/ai/test", { method: "POST" });
        setSettingsMessage(`Connected${t.models.length ? `. Models: ${t.models.slice(0, 5).join(", ")}` : ""}.`);
      } else setSettingsMessage("Saved.");
      setHealth(await api<Health>("/api/health"));
    }, (m) => setSettingsMessage(m));
  };

  const sendChat = async (message: string) => {
    setChat((c) => [...c, { role: "user", text: message }]);
    setChatPending(true);
    try {
      const r = await api<{ reply: string }>("/api/chat", { method: "POST", body: JSON.stringify({ message, context: { symbol, timeframe: frame, strategy_id: strategyId, risk: savedRisk, paper_mode: true } }) });
      setChat((c) => [...c, { role: "assistant", text: r.reply }]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", text: `That didn't work: ${errText(e)}. Everything else in APEX still works without AI.` }]);
    } finally { setChatPending(false); }
  };

  // ── Chart guides ──────────────────────────────────────────────────────
  const guides: Guide[] = useMemo(() => {
    const g: Guide[] = [];
    if (position) {
      g.push({ key: "entry", price: position.avg_price, color: "#8e8e93", title: `${position.quantity > 0 ? "Long" : "Short"} ${Math.abs(position.quantity).toLocaleString()}` });
      const sl = dragLevels.sl ?? position.stop_loss; const tp = dragLevels.tp ?? position.take_profit;
      if (sl) g.push({ key: "sl", price: sl, color: "#ff453a", title: "SL", draggable: true });
      if (tp) g.push({ key: "tp", price: tp, color: "#30d158", title: "TP", draggable: true });
    } else {
      if (Number(ticket.sl)) g.push({ key: "sl", price: Number(ticket.sl), color: "#ff453a", title: "SL", draggable: true, dashed: true });
      if (Number(ticket.tp)) g.push({ key: "tp", price: Number(ticket.tp), color: "#30d158", title: "TP", draggable: true, dashed: true });
    }
    if (Number(ticket.limit) && (ticket.type === "limit" || ticket.type === "stop_limit")) g.push({ key: "limit", price: Number(ticket.limit), color: "#ff9f0a", title: "Limit", draggable: true, dashed: true });
    if (Number(ticket.stop) && (ticket.type === "stop" || ticket.type === "stop_limit")) g.push({ key: "stop", price: Number(ticket.stop), color: "#ff9f0a", title: "Stop", draggable: true, dashed: true });
    if (aiSetup && mode !== "manual" && aiSetup.symbol === symbol && !position && !aiSetup.direction.startsWith("FLAT")) {
      g.push({ key: "ai-entry", price: aiSetup.entry, color: "#0a84ff", title: "Strategy entry", dashed: true });
      if (aiSetup.stop_loss) g.push({ key: "ai-sl", price: aiSetup.stop_loss, color: "rgba(255,69,58,0.6)", title: "Strategy stop", dashed: true });
      if (aiSetup.take_profit) g.push({ key: "ai-tp", price: aiSetup.take_profit, color: "rgba(48,209,88,0.6)", title: "Strategy target", dashed: true });
    }
    return g;
  }, [position, dragLevels, ticket, aiSetup, mode, symbol]);

  // Your paper fills on this chart, as buy and sell arrows.
  const markers: Marker[] = useMemo(() => (paper?.trades ?? []).filter((t) => t.symbol === symbol).slice(-60).map((t) => ({
    t: Math.floor(new Date(t.timestamp).getTime() / 1000), side: t.side,
    text: t.realized_pnl ? signedMoney(t.realized_pnl).replace(".00", "") : t.side === "buy" ? "Buy" : "Sell",
  })), [paper?.trades, symbol]);

  const round = (p: number) => Number(p.toPrecision(p >= 1000 ? 7 : 6));
  const onGuideDrag = (key: string, p: number) => {
    const v = round(p);
    if (position && (key === "sl" || key === "tp")) setDragLevels((d) => ({ ...d, [key]: v }));
    else setTicket((t) => ({ ...t, [key]: String(v) }));
  };
  const onGuideDrop = async (key: string, p: number) => {
    if (!position || (key !== "sl" && key !== "tp")) return;
    const v = round(p);
    const body = { stop_loss: key === "sl" ? v : position.stop_loss, take_profit: key === "tp" ? v : position.take_profit };
    const r = await run(() => api<PaperState>(`/api/paper/positions/${encodeURIComponent(symbol)}/levels`, { method: "POST", body: JSON.stringify(body) }));
    if (r) { setPaper(r); toast(`${key === "sl" ? "Stop loss" : "Take profit"} moved to ${fmtPrice(v)}`); }
    else setDragLevels({});
  };

  const emaPeriods = strategyId === "trend-following-ema"
    ? [{ period: Number(params.fast_ema) || 20, color: "#0a84ff" }, { period: Number(params.slow_ema) || 50, color: "#ff9f0a" }]
    : [];

  const canTrade = !!paper?.active && mode !== "ai_setup";
  const blockedReason = mode === "ai_setup" ? "Orders are disabled in AI Setup mode."
    : quote?.session && !quote.session.open && ticket.type === "market" ? "Market is closed. Limit and stop orders can still be placed."
    : !paper?.active ? "Engine is paused. Start it to place orders." : paper?.risk_halt ? `${paper.risk_halt}` : "";

  if (!ready) return <Startup status={backend} onRetry={restartBackend} />;

  return (
    <div className="app">
      <Toolbar paper={paper} busy={busy} canStart={mode !== "ai_setup"} startLabel={mode === "ai_auto" ? "Start AI Auto" : "Start"}
        onToggleEngine={() => void toggleEngine()} onOpenSettings={() => { setSettingsMessage(""); setSettingsOpen(true); }}
        onToggleSidebar={() => { setSidebar(!sidebar); store("apex.sidebar", sidebar ? "0" : "1"); }} />

      {(offline || paper?.risk_halt) && (
        <div className={`banner ${offline ? "bad" : "warn"}`}><Alert size={14} />{offline ? "Lost connection to the trading engine. Reconnecting…" : paper?.risk_halt}</div>
      )}

      <div className={`workspace ${sidebar ? "" : "no-sidebar"}`}>
        {sidebar && <Watchlist selected={symbol} onSelect={setSymbol} quotes={watchLive} positions={paper?.positions ?? []} />}

        <main className="main">
          <ChartPanel instrument={instrument} frame={frame} onFrame={setFrame} quote={quote} quoteError={quoteError} theme={theme}
            candles={liveCandles} candlesError={candlesError} candlesLoading={candlesLoading} emas={emaPeriods} guides={guides}
            onGuideDrag={onGuideDrag} onGuideDrop={(k, p) => void onGuideDrop(k, p)}
            markers={markers} frameSeconds={STEP[frame] ?? 3600} onOverview={() => setOverview(true)} />
          <BottomPanel tab={bottomTab} onTab={setBottomTab} paper={paper} logs={logs} busy={busy} onSelectSymbol={setSymbol}
            onClosePosition={(p) => void closePosition(p)} onCancelOrder={(o) => void cancelOrder(o)} onCloseAll={() => void closeAll()}
            chat={chat} onSendChat={(t) => void sendChat(t)} chatPending={chatPending} aiConfigured={!!health?.ai_configured} strategyName={strategy?.name ?? ""} />
        </main>

        <aside className="inspector">
          <div className="seg full inspector-tabs" role="tablist" aria-label="Panel">
            {(["trade", "strategy", "risk"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={inspector === t} className={inspector === t ? "on" : ""} onClick={() => setInspector(t)}>
                {t[0].toUpperCase() + t.slice(1)}{t === "risk" && !sameJSON(risk, savedRisk) && <i className="dot" />}
              </button>
            ))}
          </div>
          <div className="inspector-body" key={inspector}>
            {inspector === "trade" && (
              <OrderTicket ticket={ticket} onChange={setTicket} symbolLabel={instrument.label} lastPrice={quote?.price ?? null}
                equity={paper?.equity ?? 100000} freeMargin={paper?.free_margin ?? paper?.equity ?? 100000} riskPct={savedRisk.risk_pct} position={position} quote={quote}
                canTrade={canTrade} blockedReason={blockedReason} busy={busy} message={orderMessage} onSubmit={(s) => void submitOrder(s)} />
            )}
            {inspector === "strategy" && (
              <StrategyPanel mode={mode} onMode={(m) => void changeMode(m)} aiSetup={aiSetup} aiConfigured={!!health?.ai_configured}
                onGenerate={() => void generateSetup()} setupMismatch={!!aiSetup && (aiSetup.symbol !== symbol || aiSetup.timeframe !== frame)}
                strategies={strategies} strategy={strategy} strategyId={strategyId} onStrategy={(id) => { setStrategyId(id); setBacktest(null); }}
                params={params} onParam={(k, v) => setParams((p) => ({ ...p, [k]: v }))} paramsDirty={!sameJSON(params, savedParams)} onSaveParams={() => void saveParams()} paramStatus={paramStatus}
                onDuplicate={(n) => void duplicate(n)} backtest={backtest} onBacktest={() => void runBacktest()} busy={busy} message={modeMessage}
                onOverview={() => setOverview(true)} />
            )}
            {inspector === "risk" && (
              <RiskPanel risk={risk} onChange={setRisk} dirty={!sameJSON(risk, savedRisk)} onSave={() => void saveRisk()}
                paper={paper} onReset={() => void resetAccount()} busy={busy} />
            )}
          </div>
        </aside>
      </div>

      {settingsOpen && <SettingsModal initial={aiSettings} busy={busy} message={settingsMessage} onSave={(s, t) => void saveAI(s, t)} onClose={() => setSettingsOpen(false)}
        theme={themePref} onTheme={setThemePref}
        version={updater.version} update={updater.state} onCheckUpdate={() => void updater.check()} onInstallUpdate={() => { setSettingsOpen(false); void updater.install(); }} />}
      {updater.showCard && <UpdateCard state={updater.state} onInstall={() => void updater.install()} onLater={updater.dismiss} />}
      {overview && <Overview symbol={symbol} timeframe={frame} strategyId={strategyId} aiConfigured={!!health?.ai_configured} theme={theme} onClose={() => setOverview(false)} />}
      <Toasts items={toasts} />
    </div>
  );
}
