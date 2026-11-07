"""Public market-data adapters. No broker APIs or trading credentials are used."""
from __future__ import annotations
import json, ssl, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

try:  # Python from python.org on macOS ships without system certificates; certifi has them.
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover
    SSL_CONTEXT = ssl.create_default_context()

BINANCE = "https://api.binance.com/api/v3"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/"

# Yahoo Finance symbols are public quote identifiers; coverage and delay vary by instrument.
DEFAULTS = {
    "Crypto": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    "Forex": ["EURUSD=X", "GBPUSD=X", "USDJPY=X"],
    "Gold": ["GC=F"],
    "Stocks": ["AAPL", "MSFT", "NVDA"],
    "Indices": ["^GSPC", "^NDX", "^GDAXI"],
}


def market_for(symbol: str) -> str:
    s = symbol.upper()
    if s.endswith(("USDT", "USDC", "BUSD")) or (s.endswith("BTC") and len(s) > 3): return "Crypto"
    if s in ("GC=F", "SI=F"): return "Gold"
    if s.startswith("^"): return "Indices"
    if s.endswith("=X"): return "Forex"
    return "Stocks"


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 APEX-PaperTrader/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=12, context=SSL_CONTEXT) as r:
        return json.loads(r.read().decode("utf-8"))


_QUOTE_CACHE: dict = {}
_QUOTE_TTL = 3.0  # seconds; several UI timers ask for the same symbol at once


def quote(symbol: str):
    symbol = symbol.strip().upper()
    hit = _QUOTE_CACHE.get(symbol)
    if hit and time.time() - hit[0] < _QUOTE_TTL:
        return dict(hit[1])
    q = _fetch_quote(symbol)
    _QUOTE_CACHE[symbol] = (time.time(), q)
    return dict(q)


_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="apex-quotes")


def quotes(symbols):
    """Quotes for many symbols at once (the watchlist). A failing symbol is skipped."""
    def one(sym):
        try:
            return quote(sym)
        except Exception:
            return None
    return [q for q in _POOL.map(one, symbols[:40]) if q]


def _fetch_quote(symbol: str):
    if not symbol or len(symbol) > 30: raise ValueError("Invalid symbol")
    if market_for(symbol) == "Crypto":
        data = _get(f"{BINANCE}/ticker/24hr?symbol={urllib.parse.quote(symbol)}")
        price = float(data["lastPrice"])
        return {"symbol": symbol, "market": "Crypto", "price": price, "bid": float(data.get("bidPrice") or price), "ask": float(data.get("askPrice") or price), "change_pct": float(data.get("priceChangePercent") or 0), "volume": float(data.get("volume") or 0), "timestamp": datetime.now(timezone.utc).isoformat(), "source": "Binance public spot API", "delayed": False}
    encoded = urllib.parse.quote(symbol, safe="")
    data = _get(f"{YAHOO}{encoded}?range=1d&interval=1m")
    result = data["chart"]["result"][0]
    meta = result["meta"]
    price = float(meta.get("regularMarketPrice") or result["indicators"]["quote"][0]["close"][-1])
    prev = float(meta.get("chartPreviousClose") or meta.get("previousClose") or price)
    ts = meta.get("regularMarketTime") or int(time.time())
    return {"symbol": symbol, "market": market_for(symbol), "price": price, "bid": price, "ask": price, "change_pct": (price / prev - 1) * 100 if prev else 0, "volume": float(meta.get("regularMarketVolume") or 0), "timestamp": datetime.fromtimestamp(ts, timezone.utc).isoformat(), "source": "Yahoo Finance chart endpoint (availability/delay varies)", "delayed": True}


def candles(symbol: str, timeframe: str = "1h", limit: int = 300, period: str | None = None):
    symbol = symbol.strip().upper(); limit = max(2, min(int(limit), 2000))
    intervals = {"1m":"1m", "5m":"5m", "15m":"15m", "30m":"30m", "1h":"1h", "4h":"1h", "1d":"1d", "1w":"1wk"}
    interval = intervals.get(timeframe, "1h")
    if market_for(symbol) == "Crypto":
        rows = _get(f"{BINANCE}/klines?symbol={urllib.parse.quote(symbol)}&interval={timeframe if timeframe in ('1m','5m','15m','30m','1h','4h','1d','1w') else '1h'}&limit={limit}")
        out = [{"t": int(x[0] / 1000), "o": float(x[1]), "h": float(x[2]), "l": float(x[3]), "c": float(x[4]), "v": float(x[5])} for x in rows]
        return {"symbol": symbol, "timeframe": timeframe, "source": "Binance public spot API", "delayed": False, "candles": out}
    ranges = {"1m":"1d", "5m":"5d", "15m":"1mo", "30m":"1mo", "1h":"3mo", "4h":"6mo", "1d":"1y", "1w":"5y"}
    rng = period or ranges.get(timeframe, "3mo")
    data = _get(f"{YAHOO}{urllib.parse.quote(symbol, safe='')}?range={rng}&interval={interval}")
    result = data["chart"]["result"][0]
    q = result["indicators"]["quote"][0]
    out=[]
    for i, stamp in enumerate(result.get("timestamp", [])):
        vals = [q.get(k, [None]*len(result["timestamp"]))[i] for k in ("open","high","low","close")]
        if any(v is None for v in vals): continue
        out.append({"t": int(stamp), "o": float(vals[0]), "h": float(vals[1]), "l": float(vals[2]), "c": float(vals[3]), "v": float((q.get("volume") or [0]*len(result["timestamp"]))[i] or 0)})
    # After the close Yahoo appends a flat zero-volume stub bar; it isn't a real candle.
    if len(out) > 1 and timeframe not in ("1d", "1w") and out[-1]["v"] == 0 and out[-1]["o"] == out[-1]["h"] == out[-1]["l"] == out[-1]["c"]:
        out.pop()
    if timeframe == "4h":
        # Yahoo has no 4h interval, so build real 4h bars out of 1h bars.
        out = _aggregate(out, 4 * 3600)
    return {"symbol": symbol, "timeframe": timeframe, "source": "Yahoo Finance chart endpoint (availability/delay varies)", "delayed": True, "candles": out[-limit:]}


def _aggregate(bars, seconds):
    buckets = []
    for b in bars:
        start = b["t"] - b["t"] % seconds
        if buckets and buckets[-1]["t"] == start:
            cur = buckets[-1]
            cur["h"] = max(cur["h"], b["h"]); cur["l"] = min(cur["l"], b["l"]); cur["c"] = b["c"]; cur["v"] += b["v"]
        else:
            buckets.append({"t": start, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"]})
    return buckets


_MINUTE_CACHE: dict = {}


def minute_bars(symbol: str, since_ts: float):
    """1-minute candles since `since_ts` (UTC seconds), used to catch fills between polls."""
    symbol = symbol.strip().upper()
    hit = _MINUTE_CACHE.get(symbol)
    if hit and time.time() - hit[0] < 15 and hit[1] <= since_ts:
        return [b for b in hit[2] if b["t"] + 60 > since_ts]
    start = max(since_ts - 120, time.time() - 6 * 3600)  # look back at most 6 hours
    if market_for(symbol) == "Crypto":
        rows = _get(f"{BINANCE}/klines?symbol={urllib.parse.quote(symbol)}&interval=1m&startTime={int(start * 1000)}&limit=1000")
        bars = [{"t": int(x[0] / 1000), "o": float(x[1]), "h": float(x[2]), "l": float(x[3]), "c": float(x[4]), "v": float(x[5])} for x in rows]
    else:
        data = _get(f"{YAHOO}{urllib.parse.quote(symbol, safe='')}?range=1d&interval=1m")
        result = data["chart"]["result"][0]
        q = result["indicators"]["quote"][0]
        bars = []
        for i, stamp in enumerate(result.get("timestamp") or []):
            vals = [q.get(k, [None] * (i + 1))[i] for k in ("open", "high", "low", "close")]
            if any(v is None for v in vals) or stamp < start:
                continue
            bars.append({"t": int(stamp), "o": float(vals[0]), "h": float(vals[1]), "l": float(vals[2]), "c": float(vals[3]), "v": 0.0})
    _MINUTE_CACHE[symbol] = (time.time(), start, bars)
    return [b for b in bars if b["t"] + 60 > since_ts]
