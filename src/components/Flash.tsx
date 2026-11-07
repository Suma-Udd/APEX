import { useEffect, useRef, useState } from "react";

/** Renders text and briefly flashes green/red when the underlying number moves. */
export default function Flash({ value, children, className = "" }: { value: number; children: React.ReactNode; className?: string }) {
  const prev = useRef(value);
  const [dir, setDir] = useState<"" | "flash-up" | "flash-down">("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (value !== prev.current) {
      setDir(value > prev.current ? "flash-up" : "flash-down");
      setN((x) => x + 1);
      prev.current = value;
    }
  }, [value]);
  return <span key={n} className={`flash ${dir} ${className}`}>{children}</span>;
}
