"""Per-market trading conditions: leverage, spread, fees and trading hours.

Leverage caps follow the EU retail (ESMA) CFD limits, which is what a European
retail broker would give you. Spreads are typical retail values used only when a
data feed has no real bid/ask (Yahoo). Binance quotes carry the real book top.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .market_data import market_for

SPECS = {
    #            leverage  half-spread(bps)  taker bps  maker bps  min fee $
    "Crypto":  {"leverage": 2,  "half_spread_bps": 0.0, "taker_bps": 10.0, "maker_bps": 10.0, "min_fee": 0.0},
    "Forex":   {"leverage": 30, "half_spread_bps": 0.5, "taker_bps": 0.0,  "maker_bps": 0.0,  "min_fee": 0.0},
    "Gold":    {"leverage": 20, "half_spread_bps": 0.7, "taker_bps": 0.0,  "maker_bps": 0.0,  "min_fee": 0.0},
    "Indices": {"leverage": 20, "half_spread_bps": 0.6, "taker_bps": 0.0,  "maker_bps": 0.0,  "min_fee": 0.0},
    "Stocks":  {"leverage": 5,  "half_spread_bps": 1.0, "taker_bps": 2.0,  "maker_bps": 2.0,  "min_fee": 1.0},
}

# ESMA rule: positions are closed out when equity drops below 50% of used margin.
CLOSE_OUT_LEVEL = 0.5

NY = ZoneInfo("America/New_York")
BERLIN = ZoneInfo("Europe/Berlin")


def spec(symbol: str) -> dict:
    return {"market": market_for(symbol), **SPECS[market_for(symbol)]}


def bid_ask(quote: dict) -> tuple[float, float]:
    """Real bid/ask when the feed has it, otherwise mid +/- a typical retail spread."""
    price = float(quote["price"])
    bid, ask = float(quote.get("bid") or 0), float(quote.get("ask") or 0)
    if bid > 0 and ask > 0 and ask > bid:
        return bid, ask
    half = price * spec(quote["symbol"])["half_spread_bps"] / 10000
    return price - half, price + half


def fee(symbol: str, notional: float, maker: bool = False) -> float:
    s = spec(symbol)
    bps = s["maker_bps"] if maker else s["taker_bps"]
    return max(abs(notional) * bps / 10000, s["min_fee"] if notional else 0.0)


def margin_required(symbol: str, quantity: float, price: float) -> float:
    return abs(quantity) * price / spec(symbol)["leverage"]


def _session(symbol: str):
    """Returns (tz, open_time, close_time, weekdays) or None for 24/7."""
    m = market_for(symbol)
    s = symbol.upper()
    if m == "Crypto":
        return None
    if m == "Stocks" or s in ("^GSPC", "^NDX", "^DJI"):
        return (NY, (9, 30), (16, 0), {0, 1, 2, 3, 4})
    if s == "^GDAXI":
        return (BERLIN, (9, 0), (17, 30), {0, 1, 2, 3, 4})
    return "fx"  # Forex and metals: Sunday 17:00 to Friday 17:00 New York time


def is_open(symbol: str, at: datetime | None = None) -> bool:
    at = at or datetime.now(timezone.utc)
    sess = _session(symbol)
    if sess is None:
        return True
    if sess == "fx":
        ny = at.astimezone(NY)
        wd, minutes = ny.weekday(), ny.hour * 60 + ny.minute
        if wd == 5:
            return False
        if wd == 4 and minutes >= 17 * 60:
            return False
        if wd == 6 and minutes < 17 * 60:
            return False
        return True
    tz, (oh, om), (ch, cm), days = sess
    local = at.astimezone(tz)
    if local.weekday() not in days:
        return False
    minutes = local.hour * 60 + local.minute
    return oh * 60 + om <= minutes < ch * 60 + cm


def next_open(symbol: str, at: datetime | None = None) -> datetime | None:
    """Next time the market opens (minute resolution scan, at most 4 days ahead)."""
    at = (at or datetime.now(timezone.utc)).replace(second=0, microsecond=0)
    if is_open(symbol, at):
        return at
    t = at
    for _ in range(4 * 24 * 4):
        t += timedelta(minutes=15)
        if is_open(symbol, t):
            # step back to the exact minute
            while is_open(symbol, t - timedelta(minutes=1)):
                t -= timedelta(minutes=1)
            return t
    return None


def hours_label(symbol: str) -> str:
    sess = _session(symbol)
    if sess is None:
        return "24/7"
    if sess == "fx":
        return "Sun 17:00 to Fri 17:00 New York"
    return "Mon to Fri 09:30 to 16:00 New York" if sess[0] is NY else "Mon to Fri 09:00 to 17:30 Frankfurt"


def session_info(symbol: str) -> dict:
    now = datetime.now(timezone.utc)
    open_ = is_open(symbol, now)
    nxt = None if open_ else next_open(symbol, now)
    s = spec(symbol)
    return {
        "symbol": symbol.upper(), "market": s["market"], "open": open_,
        "next_open": nxt.isoformat() if nxt else None, "hours": hours_label(symbol),
        "leverage": s["leverage"], "margin_pct": round(100 / s["leverage"], 2),
        "half_spread_bps": s["half_spread_bps"], "taker_bps": s["taker_bps"], "min_fee": s["min_fee"],
    }
