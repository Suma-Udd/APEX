"""Event-driven backtester that uses the same rules as the paper account.

- Signals are computed on a candle's close and filled at the next candle's open.
- Fills pay the instrument's spread, slippage and fees.
- Size comes from risk %: (equity x risk%) / stop distance, capped by leverage.
- Stops and targets are checked against each candle's high/low. If both sit
  inside one candle the stop is assumed to hit first. Gaps fill at the open.
"""
from __future__ import annotations

import math

from . import instruments as inst
from . import signals

BARS_PER_YEAR = {"1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520, "1h": 8760, "4h": 2190, "1d": 365, "1w": 52}


def run(strategy_id, bars, params, symbol, timeframe, starting_balance=10000.0, risk_pct=0.5,
        slippage_bps=1.0, base_id=None, keep_engine=False):
    s = inst.spec(symbol)
    half = s["half_spread_bps"] / 10000
    lev = s["leverage"]
    strat = signals.build(strategy_id, bars, params, s["half_spread_bps"], base_id)
    n = len(bars)
    warm = max(2, min(strat.warmup, n - 2))

    cash = float(starting_balance)
    qty = 0.0          # signed units
    entry = 0.0
    stop = tp = None
    entry_i = None
    entry_fee = 0.0
    pending = None     # Signal decided at previous close
    entry_info = {}    # why and where the open position was entered (for the lesson replay)
    trades, curve = [], []
    fees_total = 0.0
    bars_in_market = 0

    def buy_px(p):
        return p * (1 + half) * (1 + slippage_bps / 10000)

    def sell_px(p):
        return p * (1 - half) * (1 - slippage_bps / 10000)

    def close(i, price, reason, maker=False):
        nonlocal cash, qty, entry, stop, tp, entry_i, fees_total, entry_fee, entry_info
        if qty == 0:
            return
        fill = price if maker else (sell_px(price) if qty > 0 else buy_px(price))
        fee = inst.fee(symbol, abs(qty) * fill, maker)
        pnl = (fill - entry) * qty
        cash += pnl - fee
        fees_total += fee
        risk_amt = abs(entry - stop) * abs(qty) if stop else None
        trades.append({
            "side": "long" if qty > 0 else "short", "entry_time": bars[entry_i]["t"], "exit_time": bars[i]["t"],
            "entry": round(entry, 8), "exit": round(fill, 8), "quantity": round(abs(qty), 8),
            "net_pnl": round(pnl - fee - entry_fee, 2), "r": round((pnl - fee - entry_fee) / risk_amt, 2) if risk_amt else None,
            "bars": i - entry_i, "reason": reason,
            "entry_index": entry_i, "exit_index": i, "signal_index": entry_info.get("signal_index"),
            "entry_reason": entry_info.get("reason", ""), "stop": entry_info.get("stop"), "take_profit": entry_info.get("take_profit"),
            "risk_amount": round(risk_amt, 2) if risk_amt else None,
        })
        qty, stop, tp, entry_i, entry_fee, entry_info = 0.0, None, None, None, 0.0, {}

    def equity_at(price):
        return cash + (price - entry) * qty if qty else cash

    def open_(i, sig, price):
        nonlocal cash, qty, entry, stop, tp, entry_i, fees_total, entry_fee, entry_info
        direction = 1 if sig.target > 0 else -1
        fill = buy_px(price) if direction > 0 else sell_px(price)
        eq = equity_at(price)
        if strat.sizing == "notional":
            units = abs(sig.target) * eq * strat.max_exposure_pct / 100 / fill
        else:
            dist = abs(fill - sig.stop) if sig.stop else fill * 0.01
            units = (eq * risk_pct / 100) / max(dist, fill * 1e-5)
        units = min(units, eq * lev * 0.95 / fill)  # never past the leverage cap
        if units <= 0:
            return
        fee = inst.fee(symbol, units * fill)
        cash -= fee
        fees_total += fee
        entry_fee = fee
        qty, entry, entry_i = units * direction, fill, i
        # Shift stop/target by the same amount the fill moved from the signal price.
        shift = fill - strat.c[i - 1] if i > 0 else 0
        stop = sig.stop + shift if sig.stop else None
        tp = sig.take_profit + shift if sig.take_profit else None
        entry_info = {"reason": sig.reason, "signal_index": i - 1,
                      "stop": round(stop, 8) if stop else None, "take_profit": round(tp, 8) if tp else None}

    def rebalance_grid(i, target, price):
        """Grid strategy: move inventory to a fractional target."""
        nonlocal cash, qty, entry, entry_i, fees_total
        eq = equity_at(price)
        want = target * eq * strat.max_exposure_pct / 100 / price
        delta = want - qty
        if abs(delta) * price < 1:
            return
        if qty and (qty > 0) != (want > 0) and want != 0:
            close(i, price, "grid flip")
            delta = want
        if want == 0:
            close(i, price, "grid flat")
            return
        fill = buy_px(price) if delta > 0 else sell_px(price)
        fee = inst.fee(symbol, abs(delta) * fill)
        cash -= fee
        fees_total += fee
        if qty == 0 or (qty > 0) == (delta > 0):  # adding
            entry = (entry * abs(qty) + fill * abs(delta)) / (abs(qty) + abs(delta)) if qty else fill
            entry_i = entry_i if qty else i
            qty += delta
        else:  # trimming: realize part of the P&L
            part = abs(delta)
            pnl = (fill - entry) * part * (1 if qty > 0 else -1)
            cash += pnl
            trades.append({"side": "long" if qty > 0 else "short", "entry_time": bars[entry_i]["t"], "exit_time": bars[i]["t"],
                           "entry": round(entry, 8), "exit": round(fill, 8), "quantity": round(part, 8),
                           "net_pnl": round(pnl - fee, 2), "r": None, "bars": i - entry_i, "reason": "grid take profit"})
            qty += delta

    for i in range(warm, n):
        b = bars[i]
        # 1) Fill what was decided at the previous close, at this candle's open.
        if pending is not None:
            sig, pending = pending, None
            if strat.sizing == "notional":
                rebalance_grid(i, sig.target, b["o"])
            else:
                if qty and (sig.target == 0 or (sig.target > 0) != (qty > 0)):
                    close(i, b["o"], sig.reason or "signal exit")
                if sig.target != 0 and qty == 0:
                    open_(i, sig, b["o"])

        # 2) Protective levels inside this candle.
        if qty:
            if stop and ((qty > 0 and b["l"] <= stop) or (qty < 0 and b["h"] >= stop)):
                level = min(stop, b["o"]) if qty > 0 else max(stop, b["o"])
                close(i, level, "stop loss")
            elif tp and ((qty > 0 and b["h"] >= tp) or (qty < 0 and b["l"] <= tp)):
                level = max(tp, b["o"]) if qty > 0 else min(tp, b["o"])
                close(i, level, "take profit", maker=True)

        # 3) Strategy decides on this close.
        if i < n - 1:
            pos = (qty / abs(qty) if qty else 0) if strat.sizing == "risk" else (
                qty * b["c"] / max(equity_at(b["c"]) * strat.max_exposure_pct / 100, 1e-9))
            sig = strat.decide(i, round(pos, 6) if strat.sizing == "notional" else pos)
            if sig is not None:
                pending = sig

        if qty:
            bars_in_market += 1
        curve.append((b["t"], equity_at(b["c"])))
        if equity_at(b["c"]) <= 0:
            break

    open_position = None
    if qty:
        open_position = {"direction": 1 if qty > 0 else -1, "entry": entry, "stop": stop, "take_profit": tp,
                         "since": bars[entry_i]["t"], "fraction": qty * bars[-1]["c"] / max(equity_at(bars[-1]["c"]) * getattr(strat, "max_exposure_pct", 100) / 100, 1e-9)}
        close(n - 1, bars[-1]["c"], "end of test")
        curve[-1] = (bars[-1]["t"], cash)

    out = _stats(trades, curve, starting_balance, timeframe, bars_in_market, len(curve), fees_total, lev, risk_pct)
    out["open_position"] = open_position
    if keep_engine:
        out["engine"] = strat
        out["all_trades"] = trades
    out["pending_signal"] = None if pending is None else {"target": pending.target, "stop": pending.stop, "take_profit": pending.take_profit, "reason": pending.reason}
    return out


def _stats(trades, curve, start, timeframe, in_market, total_bars, fees, lev, risk_pct):
    end = curve[-1][1] if curve else start
    wins = [t for t in trades if t["net_pnl"] > 0]
    losses = [t for t in trades if t["net_pnl"] <= 0]
    gross_win = sum(t["net_pnl"] for t in wins)
    gross_loss = -sum(t["net_pnl"] for t in losses)
    peak, max_dd, dd_now = start, 0.0, 0.0
    for _, eq in curve:
        peak = max(peak, eq)
        dd_now = (peak - eq) / peak * 100 if peak else 0
        max_dd = max(max_dd, dd_now)
    rets = [(curve[k][1] / curve[k - 1][1] - 1) for k in range(1, len(curve)) if curve[k - 1][1] > 0]
    sharpe = None
    if len(rets) > 2:
        mean = sum(rets) / len(rets)
        sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
        if sd > 0:
            sharpe = round(mean / sd * math.sqrt(BARS_PER_YEAR.get(timeframe, 8760)), 2)
    rs = [t["r"] for t in trades if t["r"] is not None]
    step = max(1, len(curve) // 300)
    return {
        "status": "completed",
        "starting_balance": start, "ending_balance": round(end, 2),
        "net_pnl": round(end - start, 2), "return_pct": round((end / start - 1) * 100, 2),
        "trades": len(trades), "wins": len(wins), "losses": len(losses),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 1) if trades else 0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "avg_win": round(gross_win / len(wins), 2) if wins else 0,
        "avg_loss": round(-gross_loss / len(losses), 2) if losses else 0,
        "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
        "max_drawdown_pct": round(max_dd, 2),
        "sharpe": sharpe,
        "exposure_pct": round(in_market / total_bars * 100, 1) if total_bars else 0,
        "fees_paid": round(fees, 2),
        "best_trade": max((t["net_pnl"] for t in trades), default=0),
        "worst_trade": min((t["net_pnl"] for t in trades), default=0),
        "equity_curve": [[t, round(e, 2)] for t, e in curve[::step]] + ([[curve[-1][0], round(curve[-1][1], 2)]] if curve else []),
        "trade_log": trades[-100:],
        "assumptions": {"risk_per_trade_pct": risk_pct, "leverage_cap": lev,
                        "fills": "next candle open + spread + 1 bps slippage + instrument fees",
                        "stops": "checked on candle high/low, stop assumed before target"},
    }
