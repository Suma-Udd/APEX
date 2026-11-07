import { useEffect, useRef, useState } from "react";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Tweens from the previous value to the new one, so numbers glide instead of jumping. */
export function useTween(value: number, ms = 450) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);
  useEffect(() => {
    if (reduced() || !Number.isFinite(value)) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    cancelAnimationFrame(raf.current);
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const v = a + (value - a) * e;
      setShown(v);
      from.current = v;
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, ms]);
  return shown;
}

export function Tween({ value, format, ms }: { value: number; format: (n: number) => string; ms?: number }) {
  return <>{format(useTween(value, ms))}</>;
}

/** Text that briefly turns green or red when the number behind it moves, like a live quote. */
export function Tick({ value, children, className = "" }: { value: number; children: React.ReactNode; className?: string }) {
  const prev = useRef(value);
  const [dir, setDir] = useState<"" | "tick-up" | "tick-down">("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (value !== prev.current && Number.isFinite(prev.current)) {
      setDir(value > prev.current ? "tick-up" : "tick-down");
      setN((x) => x + 1);
    }
    prev.current = value;
  }, [value]);
  return <span key={n} className={`tick ${dir} ${className}`}>{children}</span>;
}

/** Tiny line chart for the watchlist. */
export function Spark({ points, up }: { points: number[]; up: boolean }) {
  if (!points || points.length < 2) return <span className="spark-mini" />;
  const W = 46, H = 18;
  const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${(H - 1 - ((p - lo) / span) * (H - 2)).toFixed(1)}`).join("");
  return (
    <svg className="spark-mini" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={d} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
