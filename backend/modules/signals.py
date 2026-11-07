"""Indicators and signal logic for every built-in strategy.

Each strategy is a class with:
  __init__(bars, params)   precompute indicators on closed candles
  decide(i, pos)           called at the close of candle i with the current
                           position direction (-1, 0, +1, or a grid fraction).
                           Returns None for "do nothing", or a Signal.

The backtester and the live auto-trader both use these classes, so a strategy
behaves the same in a test as it does on the paper account.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

NaN = float("nan")


def _nan(x):
    return x != x


# ── Indicators ────────────────────────────────────────────────────────────

def ema(values, period):
    period = max(1, int(period))
    out, alpha = [], 2 / (period + 1)
    for i, v in enumerate(values):
        out.append(v if i == 0 else alpha * v + (1 - alpha) * out[-1])
    # Not trustworthy until roughly `period` samples in.
    return [NaN if i < period - 1 else x for i, x in enumerate(out)]


def sma(values, period):
    period = max(1, int(period))
    out, s = [], 0.0
    for i, v in enumerate(values):
        s += v
        if i >= period:
            s -= values[i - period]
        out.append(s / period if i >= period - 1 else NaN)
    return out


def stdev(values, period):
    period = max(2, int(period))
    m = sma(values, period)
    out = []
    for i in range(len(values)):
        if i < period - 1:
            out.append(NaN)
            continue
        w = values[i - period + 1:i + 1]
        out.append(math.sqrt(sum((x - m[i]) ** 2 for x in w) / period))
    return out


def wilder(values, period):
    period = max(1, int(period))
    out, acc = [], NaN
    for i, v in enumerate(values):
        if i < period - 1:
            out.append(NaN)
        elif i == period - 1:
            acc = sum(values[:period]) / period
            out.append(acc)
        else:
            acc = (acc * (period - 1) + v) / period
            out.append(acc)
    return out


def rsi(closes, period=14):
    gains, losses = [0.0], [0.0]
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    ag, al = wilder(gains, period), wilder(losses, period)
    out = []
    for g, l in zip(ag, al):
        if _nan(g) or _nan(l):
            out.append(NaN)
        else:
            out.append(100.0 if l == 0 else 100 - 100 / (1 + g / l))
    return out


def true_range(bars):
    out = []
    for i, b in enumerate(bars):
        if i == 0:
            out.append(b["h"] - b["l"])
        else:
            pc = bars[i - 1]["c"]
            out.append(max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc)))
    return out


def atr(bars, period=14):
    return wilder(true_range(bars), period)


def adx(bars, period=14):
    plus_dm, minus_dm = [0.0], [0.0]
    for i in range(1, len(bars)):
        up = bars[i]["h"] - bars[i - 1]["h"]
        dn = bars[i - 1]["l"] - bars[i]["l"]
        plus_dm.append(up if up > dn and up > 0 else 0.0)
        minus_dm.append(dn if dn > up and dn > 0 else 0.0)
    tr = wilder(true_range(bars), period)
    pdm, mdm = wilder(plus_dm, period), wilder(minus_dm, period)
    dx = []
    for t, p, m in zip(tr, pdm, mdm):
        if _nan(t) or t == 0:
            dx.append(NaN)
            continue
        pdi, mdi = 100 * p / t, 100 * m / t
        dx.append(0.0 if pdi + mdi == 0 else 100 * abs(pdi - mdi) / (pdi + mdi))
    first = next((i for i, v in enumerate(dx) if not _nan(v)), len(dx))
    tail = wilder(dx[first:], period)
    return [NaN] * first + tail


def macd(closes, fast=12, slow=26, signal=9):
    f, s = ema(closes, fast), ema(closes, slow)
    line = [NaN if _nan(a) or _nan(b) else a - b for a, b in zip(f, s)]
    first = next((i for i, v in enumerate(line) if not _nan(v)), len(line))
    sig = [NaN] * first + ema(line[first:], signal)
    hist = [NaN if _nan(a) or _nan(b) else a - b for a, b in zip(line, sig)]
    return line, sig, hist


def rolling_max(values, period):
    return [NaN if i < period - 1 else max(values[i - period + 1:i + 1]) for i in range(len(values))]


def rolling_min(values, period):
    return [NaN if i < period - 1 else min(values[i - period + 1:i + 1]) for i in range(len(values))]


def session_vwap(bars):
    """VWAP that resets at 00:00 UTC each day (typical price weighted by volume)."""
    out, pv, vv, day = [], 0.0, 0.0, None
    for b in bars:
        d = datetime.fromtimestamp(b["t"], timezone.utc).date()
        if d != day:
            pv, vv, day = 0.0, 0.0, d
        tp = (b["h"] + b["l"] + b["c"]) / 3
        v = b.get("v") or 1.0  # FX feeds often report no volume; fall back to equal weights
        pv += tp * v
        vv += v
        out.append(pv / vv if vv else tp)
    return out


# ── Strategy plumbing ─────────────────────────────────────────────────────

@dataclass
class Signal:
    target: float                 # -1 short, 0 flat, +1 long (grid uses fractions)
    stop: Optional[float] = None  # protective stop price for the new position
    take_profit: Optional[float] = None
    reason: str = ""


class Strategy:
    stop_atr = 1.5
    rr: Optional[float] = 2.0     # take profit as a multiple of the stop distance
    sizing = "risk"               # "risk" (stop-distance based) or "notional" (grid)
    warmup = 60

    def __init__(self, bars, params):
        self.bars = bars
        self.p = params
        self.c = [b["c"] for b in bars]
        self.atr = atr(bars, 14)

    def levels(self, i, direction, stop_dist=None):
        price = self.c[i]
        dist = stop_dist if stop_dist else self.stop_atr * self.atr[i]
        if _nan(dist) or dist <= 0:
            dist = price * 0.01
        stop = price - dist if direction > 0 else price + dist
        tp = None if self.rr is None else (price + self.rr * dist if direction > 0 else price - self.rr * dist)
        return stop, tp

    def enter(self, i, direction, reason, stop_dist=None, stop=None):
        s, tp = self.levels(i, direction, stop_dist)
        if stop is not None:
            s = stop
            d = abs(self.c[i] - s)
            tp = None if self.rr is None else (self.c[i] + self.rr * d if direction > 0 else self.c[i] - self.rr * d)
        return Signal(direction, s, tp, reason)

    def decide(self, i, pos):
        raise NotImplementedError

    @staticmethod
    def crossed_up(a, b, i):
        return not any(_nan(x) for x in (a[i], b[i], a[i - 1], b[i - 1])) and a[i - 1] <= b[i - 1] and a[i] > b[i]

    @staticmethod
    def crossed_down(a, b, i):
        return not any(_nan(x) for x in (a[i], b[i], a[i - 1], b[i - 1])) and a[i - 1] >= b[i - 1] and a[i] < b[i]


class EmaCross(Strategy):
    stop_atr, rr = 2.0, 2.0

    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.fast = ema(self.c, p.get("fast_ema", 20))
        self.slow = ema(self.c, p.get("slow_ema", 50))
        self.adx = adx(bars, 14)
        self.min_adx = float(p.get("adx_min", 20))
        self.warmup = int(p.get("slow_ema", 50)) + 2

    def decide(self, i, pos):
        strong = not _nan(self.adx[i]) and self.adx[i] >= self.min_adx
        if self.crossed_up(self.fast, self.slow, i):
            return self.enter(i, 1, f"EMA cross up, ADX {self.adx[i]:.0f}") if strong else (Signal(0, reason="EMA cross up, ADX too weak") if pos < 0 else None)
        if self.crossed_down(self.fast, self.slow, i):
            return self.enter(i, -1, f"EMA cross down, ADX {self.adx[i]:.0f}") if strong else (Signal(0, reason="EMA cross down, ADX too weak") if pos > 0 else None)
        return None


class BollingerRsi(Strategy):
    stop_atr, rr = 1.5, None

    def __init__(self, bars, p):
        super().__init__(bars, p)
        n, k = int(p.get("bb_period", 20)), float(p.get("bb_deviations", 2))
        self.mid = sma(self.c, n)
        sd = stdev(self.c, n)
        self.up = [m + k * s for m, s in zip(self.mid, sd)]
        self.lo = [m - k * s for m, s in zip(self.mid, sd)]
        self.rsi = rsi(self.c, int(p.get("rsi_period", 14)))
        self.atr_avg = sma([0 if _nan(x) else x for x in self.atr], 50)
        self.os, self.ob = float(p.get("oversold", 30)), float(p.get("overbought", 70))
        self.warmup = max(n, 50) + 2

    def decide(self, i, pos):
        c = self.c[i]
        if _nan(self.mid[i]) or _nan(self.rsi[i]):
            return None
        spike = not _nan(self.atr_avg[i]) and self.atr[i] > 2 * self.atr_avg[i]
        if pos > 0 and (c >= self.mid[i] or spike):
            return Signal(0, reason="back at middle band" if c >= self.mid[i] else "volatility spike")
        if pos < 0 and (c <= self.mid[i] or spike):
            return Signal(0, reason="back at middle band" if c <= self.mid[i] else "volatility spike")
        if pos == 0 and not spike:
            if c < self.lo[i] and self.rsi[i] < self.os:
                return self.enter(i, 1, f"below lower band, RSI {self.rsi[i]:.0f}")
            if c > self.up[i] and self.rsi[i] > self.ob:
                return self.enter(i, -1, f"above upper band, RSI {self.rsi[i]:.0f}")
        return None


class Breakout(Strategy):
    rr = 2.0

    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.n = int(p.get("range_period", 20))
        self.stop_atr = float(p.get("atr_multiplier", 1.5))
        highs, lows = [b["h"] for b in bars], [b["l"] for b in bars]
        self.hh, self.ll = rolling_max(highs, self.n), rolling_min(lows, self.n)
        self.atr_avg = sma([0 if _nan(x) else x for x in self.atr], 50)
        self.warmup = max(self.n, 50) + 2

    def decide(self, i, pos):
        if _nan(self.hh[i - 1]) or _nan(self.atr_avg[i]):
            return None
        expanding = self.atr[i] > self.atr_avg[i] and (self.bars[i]["h"] - self.bars[i]["l"]) > self.atr[i]
        if not expanding:
            return None
        if self.c[i] > self.hh[i - 1] and pos <= 0:
            return self.enter(i, 1, f"close above {self.n}-bar high")
        if self.c[i] < self.ll[i - 1] and pos >= 0:
            return self.enter(i, -1, f"close below {self.n}-bar low")
        return None


class RsiMacd(Strategy):
    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.rsi = rsi(self.c, int(p.get("rsi_period", 14)))
        self.line, self.sig, _ = macd(self.c, int(p.get("macd_fast", 12)), int(p.get("macd_slow", 26)), 9)
        self.warmup = int(p.get("macd_slow", 26)) + 12

    def decide(self, i, pos):
        r0, r1, m, s = self.rsi[i - 1], self.rsi[i], self.line[i], self.sig[i]
        if any(_nan(x) for x in (r0, r1, m, s)):
            return None
        if pos > 0 and (r1 < 50 or m < s):
            return Signal(0, reason="momentum faded")
        if pos < 0 and (r1 > 50 or m > s):
            return Signal(0, reason="momentum faded")
        if pos == 0:
            if r0 <= 50 < r1 and m > s:
                return self.enter(i, 1, f"RSI up through 50, MACD above signal")
            if r0 >= 50 > r1 and m < s:
                return self.enter(i, -1, f"RSI down through 50, MACD below signal")
        return None


class EmaVwapScalp(Strategy):
    stop_atr, rr = 0.8, 1.2

    def __init__(self, bars, p, half_spread_bps=0.0):
        super().__init__(bars, p)
        self.ema = ema(self.c, int(p.get("ema_period", 9)))
        self.vwap = session_vwap(bars)
        # Spread filter: the parameter is read as basis points of price.
        self.spread_ok = half_spread_bps * 2 <= float(p.get("max_spread_points", 1.5))
        self.warmup = int(p.get("ema_period", 9)) + 15

    def _last_bar_of_day(self, i):
        if i + 1 >= len(self.bars):
            return False
        d = lambda k: datetime.fromtimestamp(self.bars[k]["t"], timezone.utc).date()
        return d(i) != d(i + 1)

    def decide(self, i, pos):
        if pos != 0 and self._last_bar_of_day(i):
            return Signal(0, reason="flatten at session end")
        if pos != 0 or not self.spread_ok or _nan(self.ema[i]) or _nan(self.ema[i - 1]):
            return None
        b, v = self.bars[i], self.vwap[i]
        if self.c[i] > self.ema[i] > self.ema[i - 1] and b["l"] <= v < self.c[i]:
            return self.enter(i, 1, "pullback to VWAP in uptrend")
        if self.c[i] < self.ema[i] < self.ema[i - 1] and b["h"] >= v > self.c[i]:
            return self.enter(i, -1, "pullback to VWAP in downtrend")
        return None


class SwingMtf(Strategy):
    rr = 2.5
    HTF = 4  # treat 4 chart candles as one higher-timeframe candle

    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.trend = ema(self.c, int(p.get("trend_ema", 200)) * self.HTF)
        self.pull = ema(self.c, int(p.get("pullback_ema", 20)))
        self.lows, self.highs = rolling_min([b["l"] for b in bars], 10), rolling_max([b["h"] for b in bars], 10)
        self.warmup = min(len(bars) - 2, int(p.get("trend_ema", 200)) * self.HTF // 2)

    def decide(self, i, pos):
        t = self.trend[i] if not _nan(self.trend[i]) else None
        if t is None or _nan(self.pull[i]):
            return None
        buf = 0.5 * (self.atr[i] if not _nan(self.atr[i]) else self.c[i] * 0.005)
        if pos == 0 and self.c[i] > t and self.crossed_up(self.c, self.pull, i):
            return self.enter(i, 1, "pullback regained EMA in higher-TF uptrend", stop=self.lows[i] - buf)
        if pos == 0 and self.c[i] < t and self.crossed_down(self.c, self.pull, i):
            return self.enter(i, -1, "pullback lost EMA in higher-TF downtrend", stop=self.highs[i] + buf)
        if pos > 0 and self.c[i] < t:
            return Signal(0, reason="higher-TF trend broke")
        if pos < 0 and self.c[i] > t:
            return Signal(0, reason="higher-TF trend broke")
        return None


class BoundedGrid(Strategy):
    rr = None
    sizing = "notional"

    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.levels_n = int(p.get("levels", 5))
        self.lookback = int(p.get("range_lookback", 50))
        self.max_exposure_pct = float(p.get("max_exposure_pct", 5))
        self.hi = rolling_max([b["h"] for b in bars], self.lookback)
        self.lo = rolling_min([b["l"] for b in bars], self.lookback)
        self.range = None
        self.warmup = self.lookback + 1

    def decide(self, i, pos):
        if self.range is None:
            if _nan(self.hi[i - 1]):
                return None
            self.range = (self.lo[i - 1], self.hi[i - 1])
        lo, hi = self.range
        buf = 0.5 * (self.atr[i] if not _nan(self.atr[i]) else 0)
        if self.c[i] > hi + buf or self.c[i] < lo - buf:
            self.range = None  # range invalidated: flatten and re-anchor on a fresh range
            return Signal(0, reason="range broke, grid stopped") if pos != 0 else None
        mid, half = (hi + lo) / 2, (hi - lo) / 2
        if half <= 0:
            return None
        # Inventory grows one level at a time as price moves away from the middle.
        steps = round((mid - self.c[i]) / half * self.levels_n)
        steps = max(-self.levels_n, min(self.levels_n, steps))
        target = steps / self.levels_n
        if abs(target - pos) < 1e-9:
            return None
        return Signal(target, reason=f"grid level {steps:+d} of {self.levels_n}")


class VwapReversion(Strategy):
    rr = None

    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.k = float(p.get("deviation", 2))
        self.vwap = session_vwap(bars)
        dev = [c - v for c, v in zip(self.c, self.vwap)]
        self.sd = stdev(dev, 50)
        self.warmup = 52

    def decide(self, i, pos):
        v, sd = self.vwap[i], self.sd[i]
        if _nan(sd) or sd <= 0:
            return None
        up, lo = v + self.k * sd, v - self.k * sd
        if pos > 0 and self.c[i] >= v:
            return Signal(0, reason="back to VWAP")
        if pos < 0 and self.c[i] <= v:
            return Signal(0, reason="back to VWAP")
        if pos == 0:
            if self.c[i - 1] < self.vwap[i - 1] - self.k * sd and self.c[i] > lo:
                return self.enter(i, 1, "closed back inside lower band", stop=v - (self.k + 1) * sd)
            if self.c[i - 1] > self.vwap[i - 1] + self.k * sd and self.c[i] < up:
                return self.enter(i, -1, "closed back inside upper band", stop=v + (self.k + 1) * sd)
        return None


class MacdCross(Strategy):
    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.line, self.sig, self.hist = macd(self.c, int(p.get("fast", 12)), int(p.get("slow", 26)), int(p.get("signal", 9)))
        self.warmup = int(p.get("slow", 26)) + int(p.get("signal", 9)) + 2

    def decide(self, i, pos):
        if self.crossed_up(self.line, self.sig, i) and self.hist[i] > 0:
            return self.enter(i, 1, "MACD crossed above signal")
        if self.crossed_down(self.line, self.sig, i) and self.hist[i] < 0:
            return self.enter(i, -1, "MACD crossed below signal")
        return None


class Confluence(Strategy):
    def __init__(self, bars, p):
        super().__init__(bars, p)
        self.need = int(p.get("minimum_confirmations", 3))
        self.e20, self.e50 = ema(self.c, 20), ema(self.c, 50)
        self.rsi = rsi(self.c, 14)
        self.line, self.sig, _ = macd(self.c)
        self.atr_avg = sma([0 if _nan(x) else x for x in self.atr], 50)
        self.warmup = 60

    def votes(self, i):
        vals = (self.e20[i], self.e50[i], self.rsi[i], self.line[i], self.sig[i], self.atr_avg[i])
        if any(_nan(x) for x in vals):
            return 0, 0
        c = self.c[i]
        checks = [
            (c > self.e50[i], c < self.e50[i]),                     # trend: price vs EMA 50
            (self.e20[i] > self.e50[i], self.e20[i] < self.e50[i]),  # trend: EMA stack
            (self.rsi[i] > 55, self.rsi[i] < 45),                   # momentum: RSI
            (self.line[i] > self.sig[i], self.line[i] < self.sig[i]),  # momentum: MACD
        ]
        bull = sum(1 for b, _ in checks if b)
        bear = sum(1 for _, s in checks if s)
        if self.atr[i] > self.atr_avg[i]:  # volatility: only counts when expanding
            bull += 1 if bull >= bear else 0
            bear += 1 if bear > bull else 0
        return bull, bear

    def decide(self, i, pos):
        bull, bear = self.votes(i)
        if pos > 0 and bull < self.need:
            return Signal(0, reason=f"confluence dropped to {bull}")
        if pos < 0 and bear < self.need:
            return Signal(0, reason=f"confluence dropped to {bear}")
        if pos == 0 and bull >= self.need:
            return self.enter(i, 1, f"{bull} bullish confirmations")
        if pos == 0 and bear >= self.need:
            return self.enter(i, -1, f"{bear} bearish confirmations")
        return None


REGISTRY = {
    "trend-following-ema": EmaCross,
    "mean-reversion-bb-rsi": BollingerRsi,
    "breakout-volatility": Breakout,
    "momentum-rsi-macd": RsiMacd,
    "scalping-ema-vwap": EmaVwapScalp,
    "swing-mtf": SwingMtf,
    "grid-bounded": BoundedGrid,
    "vwap-reversion": VwapReversion,
    "macd-crossover": MacdCross,
    "multi-indicator-confluence": Confluence,
}


def build(strategy_id: str, bars, params, half_spread_bps=0.0, base_id: str | None = None):
    """Create the strategy engine. Custom copies run their source strategy's engine."""
    cls = REGISTRY.get(strategy_id) or REGISTRY.get(base_id or "")
    if not cls:
        raise KeyError(strategy_id)
    if cls is EmaVwapScalp:
        return cls(bars, params, half_spread_bps)
    return cls(bars, params)
