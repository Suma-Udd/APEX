const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
export const money = (n: number | undefined | null) => usd.format(Math.abs(Number(n ?? 0)) < 0.005 ? 0 : Number(n ?? 0));
export const signedMoney = (n: number | undefined | null) => {
  const v = Math.abs(Number(n ?? 0)) < 0.005 ? 0 : Number(n ?? 0);
  return `${v > 0 ? "+" : ""}${usd.format(v)}`;
};
export const pct = (n: number | undefined | null, digits = 2) => {
  const v = Number(n ?? 0);
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
};
/** Prices: more decimals for small numbers (FX), fewer for big ones (BTC, indices). */
export const price = (n: number | undefined | null) => {
  const v = Number(n ?? 0);
  const d = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 10 ? 3 : Math.abs(v) >= 1 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
};
export const qty = (n: number | undefined | null) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 6 });
export const tone = (n: number | undefined | null) => (Number(n ?? 0) > 0 ? "up" : Number(n ?? 0) < 0 ? "down" : "");
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/, "");
export const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
