import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, IPriceLine, ISeriesApi, LineSeries, LineStyle,
  UTCTimestamp, createChart, IChartApi,
} from "lightweight-charts";
import type { Candle } from "../types";
import { price as fmtPrice } from "../format";

export type Guide = { key: string; price: number; color: string; title: string; draggable?: boolean; dashed?: boolean };

type Props = {
  candles: Candle[];
  emas?: { period: number; color: string }[];
  guides: Guide[];
  onGuideDrag?: (key: string, price: number) => void;
  onGuideDrop?: (key: string, price: number) => void;
  loading?: boolean;
  error?: string;
};

function ema(values: number[], period: number) {
  const alpha = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : alpha * v + (1 - alpha) * out[i - 1]));
  return out;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function PriceChart({ candles, emas = [], guides, onGuideDrag, onGuideDrop, loading, error }: Props) {
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
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--text-3") || "#70757f", fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css("--grid") || "#1a2230" }, horzLines: { color: css("--grid") || "#1a2230" } },
      rightPriceScale: { borderColor: css("--line") || "#232c3a", scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: css("--line") || "#232c3a", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    candleSeries.current = c.addSeries(CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350",
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
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; candleSeries.current = null; volumeSeries.current = null; emaSeries.current = []; lines.current.clear(); };
  }, []);

  // Candles + volume.
  const lastKey = useRef("");
  useEffect(() => {
    const s = candleSeries.current, v = volumeSeries.current;
    if (!s || !v) return;
    s.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    v.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, value: k.v, color: k.c >= k.o ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)" })));
    // Only snap the view when the instrument/timeframe changes, not on every refresh.
    const key = `${candles.length > 0 ? candles[0].t : 0}`;
    if (key !== lastKey.current) { chart.current?.timeScale().fitContent(); lastKey.current = key; }
  }, [candles]);

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
