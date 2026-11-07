import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { SYMBOLS, findSymbol, labelFor } from "./constants";
import { errText, price as fmtPrice, signedMoney } from "./format";
import type {
  AISettings, AISetup, Backtest, Candle, Health, LogItem, OperationMode, Order, PaperState, Position, Quote, Risk,
  Strategy, StrategyResponse,
} from "./types";
import TopBar from "./components/TopBar";
import StrategyPanel from "./components/StrategyPanel";
import RiskPanel from "./components/RiskPanel";
import ChartPanel from "./components/ChartPanel";
import OrderTicket, { TicketState } from "./components/OrderTicket";
import SidePanel from "./components/SidePanel";
import SettingsModal from "./components/SettingsModal";
import Toasts, { Toast } from "./components/Toasts";
import UpdateCard from "./components/UpdateCard";
import { useUpdater } from "./updater";
import type { Guide } from "./components/PriceChart";

const DEFAULT_RISK: Risk = { risk_pct: 0.5, max_drawdown_pct: 5, max_open_positions: 3, daily_loss_limit_pct: 2 };
const EMPTY_TICKET: TicketState = { type: "market", qty: "1", limit: "", stop: "", sl: "", tp: "" };
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function App() {
  // ── Live data (polled) ────────────────────────────────────────────────
  const [health, setHealth] = useState<Health | null>(null);
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [offline, setOffline] = useState(false);

  // ── Config (loaded once and after explicit saves, never clobbered by polling) ──
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyId, setStrategyId] = useState("trend-following-ema");
  const [savedParams, setSavedParams] = useState<Record<string, number>>({});
  const [params, setParams] = useState<Record<string, number>>({});
  const [paramStatus, setParamStatus] = useState("Saved");
  const [savedRisk, setSavedRisk] = useState<Risk>(DEFAULT_RISK);
  const [risk, setRisk] = useState<Risk>(DEFAULT_RISK);
  const [riskStatus, setRiskStatus] = useState("Saved");
  const [aiSettings, setAiSettings] = useState<AISettings>({ base_url: "http://127.0.0.1:31415/v1", model: "auto", api_key_set: false });
  const [mode, setMode] = useState<OperationMode>("manual");
  const [aiSetup, setAiSetup] = useState<AISetup | null>(null);

  // ── Chart / market ────────────────────────────────────────────────────
  const [symbol, setSymbol] = useState(SYMBOLS[4].api); // BTC: trades 24/7 so there's always movement
  const [frame, setFrame] = useState("1h");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesError, setCandlesError] = useState("");
  const [candlesLoading, setCandlesLoading] = useState(false);

  // ── UI ────────────────────────────────────────────────────────────────
  const [leftTab, setLeftTab] = useState<"strategy" | "risk">("strategy");
  const [ticket, setTicket] = useState<TicketState>(EMPTY_TICKET);
  const [orderMessage, setOrderMessage] = useState("");
  const [modeMessage, setModeMessage] = useState("");
  const [backtest, setBacktest] = useState<Backtest | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [chat, setChat] = useState<{ role: "user" | "assistant"; text: string }[]>([
    { role: "assistant", text: "Research assistant. It has your selected strategy, its parameters and your paper account as context." },
  ]);
  const [chatPending, setChatPending] = useState(false);
  const [dragLevels, setDragLevels] = useState<{ sl?: number; tp?: number }>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const updater = useUpdater();

  const instrument = findSymbol(symbol) ?? SYMBOLS[0];
  const strategy = strategies.find((s) => s.id === strategyId) ?? null;
  const position = paper?.positions.find((p) => p.symbol === symbol) ?? null;

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
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
    } catch (e) { setOffline(true); toast(errText(e), "bad"); }
  }, [toast]);

  const pollLive = useCallback(async () => {
    try {
      const [h, p, l] = await Promise.all([api<Health>("/api/health"), api<PaperState>("/api/paper/state"), api<LogItem[]>("/api/logs?limit=120")]);
      setHealth(h); setPaper((old) => (sameJSON(old, p) ? old : p)); setLogs((old) => (sameJSON(old, l) ? old : l)); setOffline(false);
    } catch { setOffline(true); }
  }, []);

  useEffect(() => { void loadConfig(); void pollLive(); const t = window.setInterval(pollLive, 4000); return () => window.clearInterval(t); }, [loadConfig, pollLive]);

  // Strategy parameters: load when the selected strategy changes (not every poll).
  useEffect(() => {
    let alive = true;
    api<{ parameters: Record<string, number> }>(`/api/strategies/${encodeURIComponent(strategyId)}/parameters`)
      .then((r) => { if (alive) { setSavedParams(r.parameters); setParams(r.parameters); setParamStatus("Saved"); } })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [strategyId]);

  // Quote for the selected symbol.
  useEffect(() => {
    let alive = true;
    setQuote(null); setQuoteError("");
    const load = async () => {
      try { const q = await api<Quote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`); if (alive) { setQuote(q); setQuoteError(""); } }
      catch (e) { if (alive) setQuoteError(errText(e)); }
    };
    void load(); const t = window.setInterval(load, 10000);
    return () => { alive = false; window.clearInterval(t); };
  }, [symbol]);

  // Candles for the chart.
  useEffect(() => {
    let alive = true;
    setCandles([]); setCandlesError(""); setCandlesLoading(true);
    const load = async () => {
      try {
        const r = await api<{ candles: Candle[] }>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${frame}&limit=400`);
        if (alive) { setCandles((old) => (sameJSON(old, r.candles) ? old : r.candles)); setCandlesError(""); }
      } catch (e) { if (alive) setCandlesError(errText(e)); }
      finally { if (alive) setCandlesLoading(false); }
    };
    void load(); const t = window.setInterval(load, 30000);
    return () => { alive = false; window.clearInterval(t); };
  }, [symbol, frame]);

  // Marking positions, filling orders and running Auto all happen in the backend
  // now (every 15s), so they keep going even if this window is busy. The UI just
  // watches for new fills and announces them.
  const seenTrades = useRef<Set<string> | null>(null);
  useEffect(() => {
    const trades = paper?.trades ?? [];
    if (seenTrades.current === null) { seenTrades.current = new Set(trades.map((t) => t.id)); return; }
    for (const t of trades) {
      if (seenTrades.current.has(t.id)) continue;
      seenTrades.current.add(t.id);
      if (t.reason !== "market order" && !t.reason.startsWith("manual") && t.reason !== "close all") {
        toast(`${t.reason.charAt(0).toUpperCase()}${t.reason.slice(1)}: ${t.side.toUpperCase()} ${Number(t.quantity.toPrecision(6))} ${labelFor(t.symbol)} @ ${fmtPrice(t.price)}`, t.realized_pnl && t.realized_pnl < 0 ? "bad" : "good");
      }
    }
  }, [paper?.trades, toast]);

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
    if (r) { setSavedRisk(r); setRisk(r); setRiskStatus("Saved"); toast("Risk limits saved", "good"); void pollLive(); }
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
    toast(`${verb}: ${side.toUpperCase()} ${ticket.qty} ${instrument.label}${r.order.filled_price ? ` @ ${fmtPrice(r.order.filled_price)}` : ""}`, side === "buy" ? "good" : "bad");
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
    if (r) { void pollLive(); toast("Order cancelled"); }
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
      void pollLive();
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
      g.push({ key: "entry", price: position.avg_price, color: "#9598a1", title: `${position.quantity > 0 ? "Long" : "Short"} ${Math.abs(position.quantity).toLocaleString()}` });
      const sl = dragLevels.sl ?? position.stop_loss; const tp = dragLevels.tp ?? position.take_profit;
      if (sl) g.push({ key: "sl", price: sl, color: "#ef5350", title: "SL", draggable: true });
      if (tp) g.push({ key: "tp", price: tp, color: "#26a69a", title: "TP", draggable: true });
    } else {
      if (Number(ticket.sl)) g.push({ key: "sl", price: Number(ticket.sl), color: "#ef5350", title: "SL", draggable: true, dashed: true });
      if (Number(ticket.tp)) g.push({ key: "tp", price: Number(ticket.tp), color: "#26a69a", title: "TP", draggable: true, dashed: true });
    }
    if (Number(ticket.limit) && (ticket.type === "limit" || ticket.type === "stop_limit")) g.push({ key: "limit", price: Number(ticket.limit), color: "#e0a030", title: "Limit", draggable: true, dashed: true });
    if (Number(ticket.stop) && (ticket.type === "stop" || ticket.type === "stop_limit")) g.push({ key: "stop", price: Number(ticket.stop), color: "#e0a030", title: "Stop", draggable: true, dashed: true });
    if (aiSetup && mode !== "manual" && aiSetup.symbol === symbol && !position && !aiSetup.direction.startsWith("FLAT")) {
      g.push({ key: "ai-entry", price: aiSetup.entry, color: "#3d7eff", title: "Strategy entry", dashed: true });
      if (aiSetup.stop_loss) g.push({ key: "ai-sl", price: aiSetup.stop_loss, color: "rgba(239,83,80,0.6)", title: "Strategy stop", dashed: true });
      if (aiSetup.take_profit) g.push({ key: "ai-tp", price: aiSetup.take_profit, color: "rgba(38,166,154,0.6)", title: "Strategy target", dashed: true });
    }
    return g;
  }, [position, dragLevels, ticket, aiSetup, mode, symbol]);

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
    ? [{ period: Number(params.fast_ema) || 20, color: "#2962ff" }, { period: Number(params.slow_ema) || 50, color: "#ff9800" }]
    : [];

  const canTrade = !!paper?.active && mode !== "ai_setup";
  const blockedReason = mode === "ai_setup" ? "Orders are disabled in AI Setup mode."
    : quote?.session && !quote.session.open && ticket.type === "market" ? "Market is closed. Limit and stop orders can still be placed."
    : !paper?.active ? "Engine is paused. Start it to place orders." : paper?.risk_halt ? `${paper.risk_halt}` : "";

  return (
    <div className="app">
            <TopBar paper={paper} health={health} offline={offline} busy={busy} canStart={mode !== "ai_setup"}
        startLabel={mode === "ai_auto" ? "Start AI Auto" : "Start engine"} onToggleEngine={() => void toggleEngine()} onOpenSettings={() => { setSettingsMessage(""); setSettingsOpen(true); }} />

      {offline && <div className="banner bad">Backend not responding. Reconnecting… If this persists, restart APEX.</div>}
      {!offline && paper?.risk_halt && <div className="banner warn">{paper.risk_halt}</div>}

      <main className="workspace">
        <aside className="panel left">
          <nav className="tabs">
            <button className={leftTab === "strategy" ? "on" : ""} onClick={() => setLeftTab("strategy")}>Strategy</button>
            <button className={leftTab === "risk" ? "on" : ""} onClick={() => setLeftTab("risk")}>Risk {!sameJSON(risk, savedRisk) && <i className="dot" />}</button>
          </nav>
          <div key={leftTab} className="tab-pane">
            {leftTab === "strategy" ? (
              <StrategyPanel mode={mode} onMode={(m) => void changeMode(m)} aiSetup={aiSetup} aiConfigured={!!health?.ai_configured}
                onGenerate={() => void generateSetup()} setupMismatch={!!aiSetup && (aiSetup.symbol !== symbol || aiSetup.timeframe !== frame)}
                strategies={strategies} strategy={strategy} strategyId={strategyId} onStrategy={(id) => { setStrategyId(id); setBacktest(null); }}
                params={params} onParam={(k, v) => setParams((p) => ({ ...p, [k]: v }))} paramsDirty={!sameJSON(params, savedParams)} onSaveParams={() => void saveParams()} paramStatus={paramStatus}
                onDuplicate={(n) => void duplicate(n)} backtest={backtest} onBacktest={() => void runBacktest()} busy={busy} message={modeMessage} />
            ) : (
              <RiskPanel risk={risk} onChange={setRisk} dirty={!sameJSON(risk, savedRisk)} onSave={() => void saveRisk()} status={riskStatus}
                paper={paper} onReset={() => void resetAccount()} busy={busy} />
            )}
          </div>
        </aside>

        <section className="center">
          <ChartPanel instrument={instrument} onSymbol={setSymbol} frame={frame} onFrame={setFrame} quote={quote} quoteError={quoteError}
            candles={candles} candlesError={candlesError} candlesLoading={candlesLoading} emas={emaPeriods} guides={guides}
            onGuideDrag={onGuideDrag} onGuideDrop={(k, p) => void onGuideDrop(k, p)} />
          <OrderTicket ticket={ticket} onChange={setTicket} symbolLabel={instrument.label} lastPrice={quote?.price ?? null}
            equity={paper?.equity ?? 100000} freeMargin={paper?.free_margin ?? paper?.equity ?? 100000} riskPct={savedRisk.risk_pct} position={position} quote={quote}
            canTrade={canTrade} blockedReason={blockedReason} busy={busy} message={orderMessage} onSubmit={(s) => void submitOrder(s)} />
        </section>

        <aside className="panel right">
          <SidePanel paper={paper} logs={logs} busy={busy} onSelectSymbol={setSymbol} onClosePosition={(p) => void closePosition(p)}
            onCancelOrder={(o) => void cancelOrder(o)} onCloseAll={() => void closeAll()}
            chat={chat} onSendChat={(t) => void sendChat(t)} chatPending={chatPending} aiConfigured={!!health?.ai_configured} strategyName={strategy?.name ?? ""} />
        </aside>
      </main>

      <footer className="statusbar">
        <span><i className={offline ? "bad" : "ok"} /> Backend {offline ? "offline" : "connected"}</span>
        <span>Data: Binance · Yahoo Finance</span>
        <span>AI: {health?.ai ?? "checking"}</span>
        <span className="push">Simulated trading · no broker connection</span>
        {updater.version && <span className="mono">v{updater.version}</span>}
      </footer>

      {settingsOpen && <SettingsModal initial={aiSettings} busy={busy} message={settingsMessage} onSave={(s, t) => void saveAI(s, t)} onClose={() => setSettingsOpen(false)}
        version={updater.version} update={updater.state} onCheckUpdate={() => void updater.check()} onInstallUpdate={() => { setSettingsOpen(false); void updater.install(); }} />}
      {updater.showCard && <UpdateCard state={updater.state} onInstall={() => void updater.install()} onLater={updater.dismiss} />}
      <Toasts items={toasts} />
    </div>
  );
}
