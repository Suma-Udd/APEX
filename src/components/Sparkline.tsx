/** Tiny equity curve. Green if it ended above where it started, red if below. */
export default function Sparkline({ points, height = 56 }: { points: [number, number][]; height?: number }) {
  if (!points || points.length < 2) return <div className="spark-empty">Not enough data yet</div>;
  const W = 300, H = height;
  const vals = points.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - lo) / span) * (H - 4);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "var(--up)" : "var(--down)";
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1="0" x2={W} y1={y(vals[0])} y2={y(vals[0])} stroke="var(--line-2)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={`${d}L${W},${H}L0,${H}Z`} fill={color} opacity="0.08" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
