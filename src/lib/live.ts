import { useEffect, useRef, useState } from "react";

/**
 * Tick-by-tick crypto prices straight from Binance's public market-data websocket.
 * Polling the backend every few seconds felt dead; this pushes every trade as it happens.
 * Non-crypto markets (Yahoo) have no free stream, so those stay on polling.
 */
export type LiveTick = { price: number; change_pct?: number; bid?: number; ask?: number; at: number };

const HOSTS: string[] = (import.meta.env.VITE_BINANCE_WS as string | undefined)?.split(",") ?? [
  "wss://stream.binance.com:9443",
  "wss://data-stream.binance.vision",
];
const FLUSH_MS = 200; // at most 5 renders a second, however busy the tape is

export function useLivePrices(symbols: string[], selected: string, enabled = true) {
  const [ticks, setTicks] = useState<Record<string, LiveTick>>({});
  const [connected, setConnected] = useState(false);
  const buf = useRef<Record<string, LiveTick>>({});
  const key = symbols.join(",") + "|" + selected;

  useEffect(() => {
    if (!enabled || !symbols.length) return;
    const lower = symbols.map((s) => s.toLowerCase());
    const sel = symbols.includes(selected) ? selected.toLowerCase() : "";
    const streams = [...lower.map((s) => `${s}@miniTicker`), ...(sel ? [`${sel}@aggTrade`, `${sel}@bookTicker`] : [])].join("/");
    let ws: WebSocket | null = null;
    let host = 0, tries = 0, dead = false, retry = 0, flush = 0, dirty = false;

    const put = (sym: string, patch: Partial<LiveTick>) => {
      const old = buf.current[sym];
      buf.current[sym] = { ...old, ...patch, price: patch.price ?? old?.price ?? 0, at: Date.now() };
      dirty = true;
    };
    const open = () => {
      if (dead) return;
      try { ws = new WebSocket(`${HOSTS[host % HOSTS.length]}/stream?streams=${streams}`); }
      catch { schedule(); return; }
      ws.onopen = () => { tries = 0; setConnected(true); };
      ws.onmessage = (e) => {
        let m: { stream?: string; data?: Record<string, string | number> };
        try { m = JSON.parse(e.data as string); } catch { return; }
        const d = m.data, st = m.stream ?? "";
        if (!d) return;
        const sym = String(d.s ?? "").toUpperCase();
        if (!sym) return;
        if (st.endsWith("@aggTrade")) put(sym, { price: Number(d.p) });
        else if (st.endsWith("@bookTicker")) put(sym, { bid: Number(d.b), ask: Number(d.a) });
        else if (st.endsWith("@miniTicker")) {
          const c = Number(d.c), o = Number(d.o);
          // The selected symbol gets its price from trades; miniTicker only fills in the day change.
          put(sym, sym === selected && buf.current[sym]?.price ? { change_pct: o ? (c / o - 1) * 100 : 0 } : { price: c, change_pct: o ? (c / o - 1) * 100 : 0 });
        }
      };
      ws.onerror = () => ws?.close();
      ws.onclose = () => { setConnected(false); if (!dead) { host++; schedule(); } };
    };
    const schedule = () => { tries++; retry = window.setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(tries, 5))); };

    flush = window.setInterval(() => { if (dirty) { dirty = false; setTicks({ ...buf.current }); } }, FLUSH_MS);
    open();
    return () => { dead = true; window.clearTimeout(retry); window.clearInterval(flush); ws?.close(); setConnected(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { ticks, connected };
}
