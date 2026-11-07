import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, IPriceLine, ISeriesApi, LineSeries, LineStyle,
  UTCTimestamp, createChart, IChartApi, createSeriesMarkers, ISeriesMarkersPluginApi, SeriesMarker, Time,
} from "lightweight-charts";
import type { Candle } from "../lib/types";
import { price as fmtPrice } from "../lib/format";

export type Marker = { t: number; side: "buy" | "sell"; text?: string };
export type Guide = { key: string; price: number; color: string; title: string; draggable?: boolean; dashed?: boolean };

type Props = {
  candles: Candle[];
  emas?: { period: number; color: string }[];
  guides: Guide[];
  onGuideDrag?: (key: string, price: number) => void;
  onGuideDrop?: (key: string, price: number) => void;
  loading?: boolean;
  error?: string;
  theme?: string;
  markers?: Marker[];
};

function ema(values: number[], period: number) {
  const alpha = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : alpha * v + (1 - alpha) * out[i - 1]));
  return out;
}

export const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function palette() {
  return {
    text: css("--text-3") || "#8e8e93", grid: css("--grid") || "rgba(255,255,255,0.04)", line: css("--hairline") || "rgba(255,255,255,0.08)",
    up: css("--up") || "#30d158", down: css("--down") || "#ff453a", crosshair: css("--text-3") || "#8e8e93",
  };
}

export function chartOptions() {
  const c = palette();
  return {
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.text, fontFamily: css("--font") || "system-ui, sans-serif", fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.2 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: c.crosshair, labelBackgroundColor: c.crosshair }, horzLine: { color: c.crosshair, labelBackgroundColor: c.crosshair } },
  };
}

export const alpha = (hex: string, a: number) => {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export default function PriceChart({ candles, emas = [], guides, onGuideDrag, onGuideDrop, loading, error, theme, markers = [] }: Props) {
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeries = useRef<ISeriesApi<"Line">[]>([]);
  const lines = useRef<Map<string, IPriceLine>>(new Map());
  const dragging = useRef<string | null>(null);
  const guidesRef = useRef(guides);
  guidesRef.current = guides;
  const [hoverGuide, setHoverGuide] = useState(false);

  // Create the chart once.
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, { autoSize: true, ...chartOptions() });
    const col = palette();
    candleSeries.current = c.addSeries(CandlestickSeries, {
      upColor: col.up, downColor: col.down, borderVisible: false, wickUpColor: col.up, wickDownColor: col.down,
      priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p), minMove: 0.00001 },
      // Stretch the price scale so stop/target lines never sit off-screen.
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const res = original();
        if (!res) return res;
        for (const g of guidesRef.current) {
          res.priceRange.minValue = Math.min(res.priceRange.minValue, g.price);
          res.priceRange.maxValue = Math.max(res.priceRange.maxValue, g.price);
        }
        return res;
      },
    });
    volumeSeries.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.88, bottom: 0 } });
    chart.current = c;
    markerApi.current = createSeriesMarkers(candleSeries.current, []);
    return () => { markerApi.current = null; c.remove(); chart.current = null; candleSeries.current = null; volumeSeries.current = null; emaSeries.current = []; lines.current.clear(); };
  }, []);

  // Light / dark switch: recolour in place.
  const colors = useRef(palette());
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.applyOptions(chartOptions());
    colors.current = palette();
    const { up, down } = colors.current;
    candleSeries.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }, [theme]);

  // Candles + volume.
  const lastKey = useRef("");
  useEffect(() => {
    const s = candleSeries.current, v = volumeSeries.current;
    if (!s || !v) return;
    s.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    v.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, value: k.v, color: alpha(k.c >= k.o ? colors.current.up : colors.current.down, 0.18) })));
    // Only snap the view when the instrument/timeframe changes, not on every refresh.
    const key = `${candles.length > 0 ? candles[0].t : 0}`;
    if (key !== lastKey.current) { chart.current?.timeScale().fitContent(); lastKey.current = key; }
  }, [candles, theme]);

  // Your fills as arrows on the candles they happened in.
  useEffect(() => {
    const api = markerApi.current;
    if (!api) return;
    if (!candles.length || !markers.length) { api.setMarkers([]); return; }
    const first = candles[0].t, step = candles.length > 1 ? candles[1].t - candles[0].t : 3600;
    const { up, down } = colors.current;
    const list: SeriesMarker<Time>[] = markers
      .filter((m) => m.t >= first)
      .map((m) => ({ t: m.t - ((m.t - first) % step), m }))
      .sort((a, b) => a.t - b.t)
      .map(({ t, m }) => ({ time: t as UTCTimestamp, position: m.side === "buy" ? "belowBar" : "aboveBar", shape: m.side === "buy" ? "arrowUp" : "arrowDown", color: m.side === "buy" ? up : down, text: m.text, size: 1 }));
    api.setMarkers(list);
  }, [candles, markers, theme]);

  // EMA overlays.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    emaSeries.current.forEach((s) => c.removeSeries(s));
    emaSeries.current = [];
    if (!candles.length) return;
    const closes = candles.map((k) => k.c);
    emas.forEach(({ period, color }) => {
      if (period < 2 || period >= candles.length) return;
      const values = ema(closes, period);
      const s = c.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: `EMA ${period}` });
      s.setData(candles.slice(period).map((k, i) => ({ time: k.t as UTCTimestamp, value: values[i + period] })));
      emaSeries.current.push(s);
    });
  }, [candles, emas.map((e) => `${e.period}:${e.color}`).join("|")]);

  // Price lines (entry / SL / TP). Update in place so dragging stays smooth.
  useEffect(() => {
    const s = candleSeries.current;
    if (!s) return;
    const wanted = new Set(guides.map((g) => g.key));
    lines.current.forEach((line, key) => { if (!wanted.has(key)) { s.removePriceLine(line); lines.current.delete(key); } });
    guides.forEach((g) => {
      const opts = { price: g.price, color: g.color, lineWidth: 1 as const, lineStyle: g.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: g.title };
      const existing = lines.current.get(g.key);
      if (existing) existing.applyOptions(opts);
      else lines.current.set(g.key, s.createPriceLine(opts));
    });
  }, [guides]);

  // Dragging draggable price lines with the mouse.
  const nearGuide = (y: number) => {
    const s = candleSeries.current;
    if (!s) return null;
    for (const g of guidesRef.current) {
      if (!g.draggable) continue;
      const gy = s.priceToCoordinate(g.price);
      if (gy !== null && Math.abs(gy - y) < 7) return g.key;
    }
    return null;
  };
  const localY = (e: React.PointerEvent) => e.clientY - (box.current?.getBoundingClientRect().top ?? 0);

  const onPointerDown = (e: React.PointerEvent) => {
    const key = nearGuide(localY(e));
    if (!key) return;
    dragging.current = key;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    chart.current?.applyOptions({ handleScroll: false, handleScale: false });
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const y = localY(e);
    if (!dragging.current) { setHoverGuide(!!nearGuide(y)); return; }
    const p = candleSeries.current?.coordinateToPrice(y);
    if (p !== null && p !== undefined && p > 0) onGuideDrag?.(dragging.current, Number(p));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const key = dragging.current;
    dragging.current = null;
    chart.current?.applyOptions({ handleScroll: true, handleScale: true });
    const p = candleSeries.current?.coordinateToPrice(localY(e));
    if (p !== null && p !== undefined && p > 0) onGuideDrop?.(key, Number(p));
  };

  return (
    <div className="price-chart">
      <div ref={box} className={`price-chart-canvas ${hoverGuide ? "dragging" : ""}`}
        onPointerDownCapture={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
      {(loading || error) && !candles.length && <div className="chart-empty">{error || "Loading candles…"}</div>}
    </div>
  );
}
