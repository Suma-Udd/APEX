"""AI Overview: turns a backtest into a step-by-step lesson.

Every trade gets four short steps in plain English: why the strategy wanted in,
how the position was sized and protected, what happened, and what to take from
it. The numbers come straight from the backtest and the strategy's own
indicators, so the explanation always matches what the engine actually did.
"""
from __future__ import annotations

import math

from . import signals

# Indicator series that sit on the price chart, by attribute name on the engine.
OVERLAYS = {
    "fast": "Fast EMA", "slow": "Slow EMA", "ema": "EMA", "trend": "Trend EMA", "pull": "Pullback EMA",
    "mid": "Middle band", "up": "Upper band", "lo": "Lower band", "hh": "Range high", "ll": "Range low",
    "hi": "Grid high", "vwap": "VWAP",
}
# Oscillators: read at the signal candle and quoted in the explanation.
READINGS = {"rsi": "RSI", "adx": "ADX", "atr": "ATR", "line": "MACD", "sig": "MACD signal"}


def _ok(x):
    return x is not None and not (isinstance(x, float) and math.isnan(x))


def _r(x, digits=2):
    return None if not _ok(x) else round(float(x), digits)


def fmt(p):
    p = float(p)
    if abs(p) >= 1000:
        return f"{p:,.2f}"
    if abs(p) >= 10:
        return f"{p:,.3f}"
    if abs(p) >= 1:
        return f"{p:.4f}"
    return f"{p:.6f}"


def money(v):
    v = float(v)
    return f"{'-' if v < 0 else ''}${abs(v):,.2f}"


def overlays(engine, n, start):
    out = []
    lo_name = "Grid low" if isinstance(engine, signals.BoundedGrid) else "Lower band"
    for attr, label in OVERLAYS.items():
        series = getattr(engine, attr, None)
        if not isinstance(series, list) or len(series) != n:
            continue
        if attr == "lo":
            label = lo_name
        pts = [[i - start, _r(v, 8)] for i, v in enumerate(series) if i >= start and _ok(v)]
        if pts:
            out.append({"key": attr, "label": label, "points": pts})
    return out


def readings(engine, i):
    out = {}
    for attr, label in READINGS.items():
        series = getattr(engine, attr, None)
        if isinstance(series, list) and 0 <= i < len(series) and _ok(series[i]):
            out[label] = _r(series[i], 2)
    return out


def why(strategy_id, side, reason, rd, params, engine):
    """Plain-language reason the strategy entered, built from its real readings."""
    up = side == "long"
    adx = rd.get("ADX")
    rsi = rd.get("RSI")
    if strategy_id == "trend-following-ema":
        f, s = params.get("fast_ema", 20), params.get("slow_ema", 50)
        txt = (f"The fast EMA ({f}) crossed {'above' if up else 'below'} the slow EMA ({s}). Recent prices were moving "
               f"{'up' if up else 'down'} faster than the longer average, which is often how a new {'up' if up else 'down'}trend starts.")
        if adx is not None:
            txt += f" ADX was {adx:.0f}, above the minimum of {float(params.get('adx_min', 20)):g}, so the move had real strength behind it."
        return txt
    if strategy_id == "mean-reversion-bb-rsi":
        return (f"Price closed {'below the lower' if up else 'above the upper'} Bollinger Band, an unusually stretched move. "
                f"RSI was {rsi:.0f}, {'oversold' if up else 'overbought'}. The bet: stretched prices tend to snap back toward the middle band."
                if rsi is not None else f"Price was stretched {'below' if up else 'above'} its normal range, so the strategy bet on a snap back.")
    if strategy_id == "breakout-volatility":
        n = params.get("range_period", 20)
        return (f"Price closed {'above the highest high' if up else 'below the lowest low'} of the last {n} candles while volatility was expanding. "
                f"A break out of a range with bigger candles than usual often keeps going in the same direction.")
    if strategy_id == "momentum-rsi-macd":
        return (f"RSI crossed {'up' if up else 'down'} through 50{f' (now {rsi:.0f})' if rsi is not None else ''} and MACD was "
                f"{'above' if up else 'below'} its signal line. Two momentum tools agreed that buyers{'' if up else ' had lost control and sellers'} were taking over.")
    if strategy_id == "scalping-ema-vwap":
        return (f"Price was {'above' if up else 'below'} both the fast EMA and the session VWAP, and pulled back to the EMA. "
                f"Scalpers join the short-term trend on small pullbacks and get out quickly.")
    if strategy_id == "swing-mtf":
        return (f"The long-term trend EMA pointed {'up' if up else 'down'}, and price pulled back to the shorter EMA before turning again. "
                f"Swing traders buy dips in uptrends (or sell rallies in downtrends) instead of chasing.")
    if strategy_id == "grid-bounded":
        return (f"Price moved toward the {'bottom' if up else 'top'} of its recent range, so the grid {'added' if up else 'reduced'} exposure. "
                f"Grids buy low and sell high inside a range, step by step.")
    if strategy_id == "vwap-reversion":
        return (f"Price stretched far {'below' if up else 'above'} the session VWAP (the average price weighted by volume). "
                f"The strategy bets it drifts back toward that fair-value line.")
    if strategy_id == "macd-crossover":
        return (f"The MACD line crossed {'above' if up else 'below'} its signal line, meaning short-term momentum turned "
                f"{'up' if up else 'down'} compared with the longer trend.")
    if strategy_id == "multi-indicator-confluence":
        return (f"{reason.capitalize()}. Instead of trusting one indicator, this strategy waits until several agree "
                f"({'trend, momentum and price location all pointed up' if up else 'trend, momentum and price location all pointed down'}).")
    return f"The strategy's rule fired: {reason}."


def plan(t, risk_pct, atr_value):
    entry, stop, tp = t["entry"], t.get("stop"), t.get("take_profit")
    parts = [f"Entered {'long' if t['side'] == 'long' else 'short'} at {fmt(entry)} on the next candle's open, after the signal candle closed."]
    if stop:
        dist = abs(entry - stop)
        pct = dist / entry * 100
        atr_txt = f", about {dist / atr_value:.1f}× ATR" if atr_value else ""
        parts.append(f"Stop at {fmt(stop)}, {pct:.2f}% away{atr_txt}. Size was picked so hitting it costs {risk_pct}% of the account"
                     + (f" ({money(t['risk_amount'])})." if t.get("risk_amount") else "."))
    if tp and stop:
        rr = abs(tp - entry) / max(abs(entry - stop), 1e-12)
        parts.append(f"Target at {fmt(tp)}: {rr:.1f}× the risk. Win once and it pays for {rr:.1f} losses.")
    elif stop:
        parts.append("No fixed target. The strategy exits on its own signal and lets the winner run.")
    return " ".join(parts)


def outcome(t):
    pnl, r, bars, reason = t["net_pnl"], t.get("r"), t["bars"], t["reason"]
    held = f"{bars} candle{'s' if bars != 1 else ''}"
    r_txt = f" ({r:+.1f}R)" if r is not None else ""
    if reason == "take profit":
        return f"Price reached the target after {held}. Closed for {money(pnl)}{r_txt}."
    if reason == "stop loss":
        return f"Price hit the stop after {held}. Closed for {money(pnl)}{r_txt}. The loss was the size planned before entering."
    if reason == "end of test":
        return f"Still open when the test ended, valued at {money(pnl)}{r_txt} after {held}."
    return f"Exited after {held} because {reason}. Closed for {money(pnl)}{r_txt}."


def takeaway(t):
    pnl, r, reason = t["net_pnl"], t.get("r"), t["reason"]
    if reason == "take profit":
        return "The plan worked as written. Letting a winner reach its target is what makes the losers affordable."
    if reason == "stop loss" and r is not None and r <= -1.3:
        return "The price jumped past the stop, so the loss was bigger than planned. That's slippage, and it happens in fast markets."
    if reason == "stop loss":
        return "Losses are part of every strategy. The stop kept this one small, so a few of these can't sink the account."
    if pnl > 0:
        return "The strategy left because its reason to be in the trade was gone, not because of the profit. Rules over feelings."
    if reason == "end of test":
        return "Unfinished trades are a reminder: a result isn't real until the position is closed."
    return "A small loss on a signal exit is the strategy admitting it was wrong early. Cheap mistakes are good mistakes."


def summary(bt):
    trades, wins = bt["trades"], bt["wins"]
    if not trades:
        return ["No trades. The strategy's conditions never lined up on this chart. That is also an answer: not every market suits every strategy."]
    out = []
    wr = bt["win_rate_pct"]
    aw, al = bt.get("avg_win") or 0, abs(bt.get("avg_loss") or 0)
    if al and aw:
        ratio = aw / al
        out.append(f"Won {wr:.0f}% of trades. The average win was {ratio:.1f}× the average loss.")
        breakeven = 100 / (1 + ratio)
        out.append(f"With that ratio you only need to win {breakeven:.0f}% of the time to break even, "
                   + ("and this strategy did better than that." if wr > breakeven else "and this strategy fell short of that."))
    out.append(f"Worst drop from a high: {bt['max_drawdown_pct']:.1f}%. Ask yourself if you could sit through that with real money.")
    if bt.get("fees_paid"):
        out.append(f"Spreads and fees cost {money(bt['fees_paid'])}. Strategies that trade a lot pay a lot.")
    return out


LEAD_IN = 48


def build(strategy, eid, bars, params, bt, risk_pct, symbol, timeframe, max_bars=320):
    """bars: candles the backtest ran on. Returns the replay window and one lesson per trade."""
    engine = bt["engine"]
    n = len(bars)
    # A short lead-in with no lessons, so the first trade has some chart history to its left.
    start = max(0, n - max_bars - LEAD_IN)
    first_entry = start + min(LEAD_IN, n - start)
    window = bars[start:]
    lessons = []
    for t in bt["all_trades"]:
        ei, xi = t.get("entry_index"), t.get("exit_index")
        if ei is None or xi is None or ei < first_entry:
            continue
        si = t.get("signal_index") or max(ei - 1, 0)
        rd = readings(engine, si)
        atr_v = rd.get("ATR")
        win = t["net_pnl"] > 0
        lessons.append({
            "side": t["side"], "entry_bar": ei - start, "exit_bar": xi - start, "signal_bar": si - start,
            "entry": t["entry"], "exit": t["exit"], "stop": t.get("stop"), "take_profit": t.get("take_profit"),
            "pnl": t["net_pnl"], "r": t.get("r"), "bars": t["bars"], "exit_reason": t["reason"], "win": win,
            "signal": t.get("entry_reason", ""), "readings": {k: v for k, v in rd.items() if k != "ATR"},
            "steps": [
                {"title": "Why", "text": why(eid, t["side"], t.get("entry_reason", ""), rd, params, engine)},
                {"title": "Plan", "text": plan(t, risk_pct, atr_v)},
                {"title": "Result", "text": outcome(t)},
                {"title": "Takeaway", "text": takeaway(t)},
            ],
        })
    first_t = bars[first_entry]["t"] if first_entry < n else 0
    curve = [[t, e] for t, e in bt["equity_curve"] if t >= first_t]
    # Stats for the replayed window only, so the numbers match what the viewer just watched.
    wins = [x for x in lessons if x["win"]]
    losses = [x for x in lessons if not x["win"]]
    net = round(sum(x["pnl"] for x in lessons), 2)
    eq0 = curve[0][1] if curve else bt.get("starting_balance") or 10000
    peak, dd = eq0, 0.0
    for _, e in curve:
        peak = max(peak, e)
        dd = max(dd, (peak - e) / peak * 100 if peak else 0)
    gross_l = -sum(x["pnl"] for x in losses)
    stats = {
        "trades": len(lessons), "wins": len(wins), "losses": len(losses),
        "win_rate_pct": round(len(wins) / len(lessons) * 100, 1) if lessons else 0,
        "net_pnl": net, "return_pct": round(net / eq0 * 100, 2) if eq0 else 0, "max_drawdown_pct": round(dd, 2),
        "profit_factor": round(sum(x["pnl"] for x in wins) / gross_l, 2) if gross_l > 0 else None,
        "avg_win": round(sum(x["pnl"] for x in wins) / len(wins), 2) if wins else 0,
        "avg_loss": round(sum(x["pnl"] for x in losses) / len(losses), 2) if losses else 0,
        "starting_balance": round(eq0, 2),
    }
    return {
        "strategy": {"id": strategy["id"], "name": strategy["name"], "category": strategy.get("category", ""),
                     "description": strategy.get("description", ""), "entry": strategy.get("entry", []), "exit": strategy.get("exit", [])},
        "symbol": symbol, "timeframe": timeframe, "parameters": params, "risk_pct": risk_pct,
        "candles": window, "overlays": overlays(engine, n, start), "lessons": lessons, "equity_curve": curve,
        "stats": stats,
        "window_trades": len(lessons),
        "summary": summary({**stats, "fees_paid": None}),
    }
