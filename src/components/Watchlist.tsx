import { useMemo, useState } from "react";
import { MARKETS, SYMBOLS } from "../lib/constants";
import { pct, price, tone } from "../lib/format";
import type { MiniQuote, Position } from "../lib/types";
import { Search } from "./Icons";
import { Spark, Tick } from "./Motion";

type Props = {
  selected: string; onSelect: (api: string) => void;
  quotes: Record<string, MiniQuote>; positions: Position[];
};

export default function Watchlist({ selected, onSelect, quotes, positions }: Props) {
  const [q, setQ] = useState("");
  const held = useMemo(() => new Set(positions.map((p) => p.symbol)), [positions]);
  const needle = q.trim().toLowerCase();
  const match = (s: (typeof SYMBOLS)[number]) => !needle || `${s.label} ${s.name} ${s.api}`.toLowerCase().includes(needle);

  return (
    <aside className="watchlist">
      <label className="search">
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search markets" spellCheck={false} />
      </label>
      <div className="watch-scroll">
        {MARKETS.map((m) => {
          const items = SYMBOLS.filter((s) => s.market === m && match(s));
          if (!items.length) return null;
          return (
            <section key={m}>
              <h4>{m}</h4>
              {items.map((s) => {
                const quote = quotes[s.api];
                return (
                  <button key={s.api} className={`watch-row ${selected === s.api ? "on" : ""}`} onClick={() => onSelect(s.api)}>
                    <span className="watch-name">
                      <b>{s.label}{held.has(s.api) && <i className="held" title="Open position" />}</b>
                      <small>{s.name}</small>
                    </span>
                    {quote?.spark && <Spark points={quote.spark} up={quote.change_pct >= 0} />}
                    <span className="watch-px">
                      {quote ? <Tick value={quote.price} className="num">{price(quote.price)}</Tick> : <span className="num">–</span>}
                      {quote ? <small className={`chg ${tone(quote.change_pct)}`}>{pct(quote.change_pct)}</small> : <small className="chg">&nbsp;</small>}
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
