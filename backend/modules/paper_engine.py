"""Local paper broker: margin account, bid/ask fills, fees, sessions, intrabar triggers.

Account model (like a retail CFD / margin broker):
  balance      cash after realized P&L and fees
  equity       balance + unrealized P&L (longs marked at bid, shorts at ask)
  used_margin  sum of |qty| x price / leverage across open positions
  free_margin  equity - used_margin; new exposure needs enough of it
Positions get force-closed when equity drops below 50% of used margin (ESMA close-out).

Pending orders and stop-loss / take-profit levels are checked against every
1-minute candle since the last check, so a spike through your stop between two
polls still fills, and at the stop price (or worse, if price gapped past it).
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from . import instruments as inst

INITIAL_BALANCE = 100_000.0
EPS = 1e-10


def now():
    return datetime.now(timezone.utc).isoformat()


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def empty_state():
    return {
        "mode": "paper", "feed": "not_connected", "active": False,
        "balance": INITIAL_BALANCE, "equity": INITIAL_BALANCE,
        "realized_pnl": 0.0, "floating_pnl": 0.0, "fees_paid": 0.0,
        "used_margin": 0.0, "free_margin": INITIAL_BALANCE, "margin_level": None,
        "positions": [], "orders": [], "trades": [], "equity_history": [],
        "peak_equity": INITIAL_BALANCE, "day": today(), "day_start_equity": INITIAL_BALANCE,
        "checked": {}, "risk_halt": None, "updated_at": now(),
    }


def migrate(state):
    """Fill in fields older saved states don't have."""
    base = empty_state()
    for k, v in base.items():
        state.setdefault(k, v)
    for p in state["positions"]:
        p.setdefault("bid", p.get("mark_price", p["avg_price"]))
        p.setdefault("ask", p.get("mark_price", p["avg_price"]))
    return state


# ── Marking ────────────────────────────────────────────────────────────────

def _mark_position(p):
    qty = float(p["quantity"])
    exit_px = float(p.get("bid") if qty > 0 else p.get("ask")) or float(p["mark_price"])
    p["unrealized_pnl"] = round((exit_px - float(p["avg_price"])) * qty, 2)
    p["margin"] = round(inst.margin_required(p["symbol"], qty, float(p["mark_price"])), 2)


def mark_state(state):
    for p in state.get("positions", []):
        _mark_position(p)
    floating = sum(float(p.get("unrealized_pnl", 0)) for p in state.get("positions", []))
    used = sum(float(p.get("margin", 0)) for p in state.get("positions", []))
    state["floating_pnl"] = round(floating, 2)
    state["equity"] = round(float(state.get("balance", INITIAL_BALANCE)) + floating, 2)
    state["used_margin"] = round(used, 2)
    state["free_margin"] = round(state["equity"] - used, 2)
    state["margin_level"] = round(state["equity"] / used * 100, 1) if used > 0 else None
    state["peak_equity"] = max(float(state.get("peak_equity", state["equity"])), state["equity"])
    if state.get("day") != today():
        state["day"] = today()
        state["day_start_equity"] = state["equity"]
    state.setdefault("day_start_equity", state["equity"])
    state["updated_at"] = now()
    return state


def record_equity(state, max_points=1500):
    """Append an equity sample (at most one per minute) for the account curve."""
    hist = state.setdefault("equity_history", [])
    t = int(datetime.now(timezone.utc).timestamp()) // 60 * 60
    if hist and hist[-1][0] == t:
        hist[-1][1] = state["equity"]
    else:
        hist.append([t, state["equity"]])
    del hist[:-max_points]


# ── Risk gates ─────────────────────────────────────────────────────────────

def risk_check(state, risk):
    """Your own APEX risk limits. Returns a reason string when new exposure is blocked."""
    mark_state(state)
    equity = float(state["equity"])
    peak = float(state.get("peak_equity") or equity)
    day_start = float(state.get("day_start_equity") or equity)
    max_dd = float(risk.get("max_drawdown_pct", 100))
    daily = float(risk.get("daily_loss_limit_pct", 100))
    if peak > 0 and (peak - equity) / peak * 100 >= max_dd:
        return f"Max drawdown of {max_dd:g}% reached (equity {equity:,.2f} vs high {peak:,.2f}). Only closing orders are allowed."
    if day_start > 0 and (day_start - equity) / day_start * 100 >= daily:
        return f"Daily loss limit of {daily:g}% reached. Only closing orders are allowed until 00:00 UTC."
    return None


def _position(state, symbol):
    return next((p for p in state["positions"] if p["symbol"] == symbol), None)


def exposure_delta(state, symbol, side, qty):
    """How much new exposure (in units) an order adds. 0 if it only reduces."""
    pos = _position(state, symbol)
    signed = qty if side == "buy" else -qty
    current = float(pos["quantity"]) if pos else 0.0
    if current * signed >= 0:
        return abs(signed)
    return max(0.0, abs(signed) - abs(current))


def _gate(state, risk, symbol, side, qty, price):
    """Raise ValueError if an order that adds exposure is not allowed right now."""
    added = exposure_delta(state, symbol, side, qty)
    if added <= EPS:
        return
    halted = risk_check(state, risk)
    if halted:
        raise ValueError(halted)
    if not _position(state, symbol) and len(state["positions"]) >= int(risk.get("max_open_positions", 3)):
        raise ValueError(f"Max open positions ({int(risk.get('max_open_positions', 3))}) reached")
    need = inst.margin_required(symbol, added, price)
    if need > float(state["free_margin"]) + 1e-6:
        lev = inst.spec(symbol)["leverage"]
        max_units = max(0.0, float(state["free_margin"])) * lev / price
        raise ValueError(f"Insufficient margin: needs {need:,.2f}, free {max(0.0, state['free_margin']):,.2f} "
                         f"({lev}:1 leverage, max about {max_units:,.6g} units)")


# ── Fills ──────────────────────────────────────────────────────────────────

def fill_order(state, symbol, side, qty, price, maker=False, sl=None, tp=None, reason="market order"):
    """Book a fill at `price` (already including spread/slippage)."""
    fee = inst.fee(symbol, qty * price, maker)
    signed = qty if side == "buy" else -qty
    pos = _position(state, symbol)
    realized = 0.0

    if pos and float(pos["quantity"]) * signed < 0:
        current = float(pos["quantity"])
        direction = 1 if current > 0 else -1
        close_qty = min(abs(current), qty)
        realized = (price - float(pos["avg_price"])) * close_qty * direction
        state["realized_pnl"] = round(float(state.get("realized_pnl", 0)) + realized, 2)
        state["balance"] = round(float(state["balance"]) + realized, 2)
        remaining = round(current + signed, 10)
        if abs(remaining) < EPS:
            state["positions"].remove(pos)
            pos = None
        elif remaining * direction < 0:
            pos.update({"quantity": remaining, "avg_price": price, "opened_at": now(),
                        "stop_loss": float(sl) if sl else None, "take_profit": float(tp) if tp else None})
        else:
            pos["quantity"] = remaining
    else:
        if not pos:
            pos = {"id": str(uuid4()), "symbol": symbol, "quantity": 0.0, "avg_price": price, "mark_price": price,
                   "bid": price, "ask": price, "unrealized_pnl": 0.0, "margin": 0.0,
                   "stop_loss": None, "take_profit": None, "opened_at": now()}
            state["positions"].append(pos)
        old = float(pos["quantity"])
        new = old + signed
        pos["avg_price"] = (abs(old) * float(pos["avg_price"]) + abs(signed) * price) / abs(new) if new else price
        pos["quantity"] = new
        if sl:
            pos["stop_loss"] = float(sl)
        if tp:
            pos["take_profit"] = float(tp)

    state["balance"] = round(float(state["balance"]) - fee, 2)
    state["fees_paid"] = round(float(state.get("fees_paid", 0)) + fee, 2)
    trade = {"id": str(uuid4()), "symbol": symbol, "side": side, "quantity": qty, "price": round(price, 10),
             "fee": round(fee, 4), "realized_pnl": round(realized, 2), "reason": reason, "timestamp": now()}
    state["trades"].append(trade)
    state["trades"] = state["trades"][-2000:]
    mark_state(state)
    return trade


def _taker_price(symbol, side, mid, quote=None, slip_bps=1.0):
    if quote is not None:
        bid, ask = inst.bid_ask(quote)
        base = ask if side == "buy" else bid
    else:
        half = mid * inst.spec(symbol)["half_spread_bps"] / 10000
        base = mid + half if side == "buy" else mid - half
    slip = base * slip_bps / 10000
    return base + slip if side == "buy" else base - slip


def submit_order(state, order, quote, risk):
    side = str(order["side"]).lower()
    typ = str(order.get("type", "market")).lower()
    qty = float(order["quantity"])
    symbol = quote["symbol"]
    price = float(quote["price"])
    if side not in ("buy", "sell") or typ not in ("market", "limit", "stop", "stop_limit"):
        raise ValueError("Unsupported side or order type")
    if qty <= 0:
        raise ValueError("Quantity must be positive")
    limit = float(order.get("limit_price") or 0)
    stop = float(order.get("stop_price") or 0)
    if typ in ("limit", "stop_limit") and limit <= 0:
        raise ValueError("Limit price is required")
    if typ in ("stop", "stop_limit") and stop <= 0:
        raise ValueError("Stop price is required")
    sl, tp = order.get("stop_loss"), order.get("take_profit")
    _validate_levels(side, price, sl, tp)

    mark_state(state)
    open_now = inst.is_open(symbol)
    bid, ask = inst.bid_ask(quote)
    base = {"id": str(uuid4()), "symbol": symbol, "side": side, "type": typ, "quantity": qty,
            "stop_loss": sl, "take_profit": tp, "created_at": now()}

    def pending(**extra):
        # Check margin up front too, so you find out now and not when it triggers.
        _gate(state, risk, symbol, side, qty, limit or stop or price)
        item = {**base, **extra}
        state["orders"].append(item)
        state["orders"] = state["orders"][-500:]
        return item

    marketable_limit = (side == "buy" and ask <= limit) or (side == "sell" and bid >= limit)
    if typ == "limit" and not (open_now and marketable_limit):
        return pending(limit_price=limit, status="pending")
    if typ in ("stop", "stop_limit"):
        hit = (ask >= stop) if side == "buy" else (bid <= stop)
        if not (open_now and hit):
            return pending(stop_price=stop, limit_price=limit or None, status="pending")
        if typ == "stop_limit" and not marketable_limit:
            return pending(stop_price=stop, limit_price=limit, status="triggered", triggered_at=now())

    if not open_now:
        nxt = inst.next_open(symbol)
        raise ValueError(f"{inst.spec(symbol)['market']} market is closed. Opens {nxt.strftime('%a %H:%M UTC') if nxt else 'later'}. "
                         "You can still place limit and stop orders.")
    _gate(state, risk, symbol, side, qty, price)
    slip = float(order.get("slippage_bps", 1))
    fill_px = _taker_price(symbol, side, price, quote, slip)
    if typ == "limit":  # marketable limit: never worse than the limit
        fill_px = min(fill_px, limit) if side == "buy" else max(fill_px, limit)
    trade = fill_order(state, symbol, side, qty, fill_px, False, sl, tp,
                       "market order" if typ == "market" else f"{typ.replace('_', ' ')} filled")
    pos = _position(state, symbol)
    if pos:  # mark at the live quote right away, so the spread cost shows up straight after the fill
        pos.update({"mark_price": price, "bid": bid, "ask": ask})
        mark_state(state)
    record = {**base, "status": "filled", "filled_price": round(fill_px, 10), "trade_id": trade["id"], "filled_at": now()}
    state["orders"].append(record)
    state["orders"] = state["orders"][-500:]
    return {**record, "trade": trade}


def _validate_levels(side, price, sl, tp):
    if sl and ((side == "buy" and sl >= price) or (side == "sell" and sl <= price)):
        raise ValueError("Stop loss must be below the price for a buy and above it for a sell")
    if tp and ((side == "buy" and tp <= price) or (side == "sell" and tp >= price)):
        raise ValueError("Take profit must be above the price for a buy and below it for a sell")


# ── Trigger processing ─────────────────────────────────────────────────────

def _process_bar(state, symbol, bar, risk, opened_before):
    """Check pending orders and SL/TP of one symbol against one candle (mid prices)."""
    o, h, l = float(bar["o"]), float(bar["h"]), float(bar["l"])

    # 1) Protective levels on positions that existed before this candle. If both
    #    SL and TP sit inside the same candle we assume the stop hit first (conservative).
    pos = _position(state, symbol)
    if pos and pos["id"] in opened_before:
        qty = float(pos["quantity"])
        sl, tp = pos.get("stop_loss"), pos.get("take_profit")
        side = "sell" if qty > 0 else "buy"
        if sl and ((qty > 0 and l <= sl) or (qty < 0 and h >= sl)):
            level = min(sl, o) if qty > 0 else max(sl, o)  # gap through the stop fills at the open
            fill_order(state, symbol, side, abs(qty), _taker_price(symbol, side, level), reason="stop loss")
        elif tp and ((qty > 0 and h >= tp) or (qty < 0 and l <= tp)):
            level = max(tp, o) if qty > 0 else min(tp, o)
            fill_order(state, symbol, side, abs(qty), level, maker=True, reason="take profit")

    # 2) Working orders.
    for od in list(state.get("orders", [])):
        if od["symbol"] != symbol or od.get("status") not in ("pending", "triggered"):
            continue
        side, typ = od["side"], od["type"]
        if typ in ("stop", "stop_limit") and od["status"] == "pending":
            st = float(od["stop_price"])
            if not ((side == "buy" and h >= st) or (side == "sell" and l <= st)):
                continue
            if typ == "stop_limit":
                od["status"] = "triggered"
                od["triggered_at"] = now()
            else:
                level = max(st, o) if side == "buy" else min(st, o)
                _fill_working(state, od, _taker_price(symbol, side, level), False, risk)
                continue
        if typ in ("limit", "stop_limit") and od["status"] in ("pending", "triggered"):
            lim = float(od["limit_price"])
            if (side == "buy" and l <= lim) or (side == "sell" and h >= lim):
                level = min(lim, o) if side == "buy" else max(lim, o)
                _fill_working(state, od, level, True, risk)


def _fill_working(state, od, price, maker, risk):
    try:
        mark_state(state)
        _gate(state, risk, od["symbol"], od["side"], float(od["quantity"]), price)
    except ValueError as exc:
        od.update({"status": "rejected", "reject_reason": str(exc), "rejected_at": now()})
        return
    trade = fill_order(state, od["symbol"], od["side"], float(od["quantity"]), price, maker,
                       od.get("stop_loss"), od.get("take_profit"), reason=f"{od['type'].replace('_', ' ')} order filled")
    od.update({"status": "filled", "filled_price": round(price, 10), "trade_id": trade["id"], "filled_at": now()})


def update_quotes(state, quotes, bars_by_symbol=None, risk=None):
    """Mark to market, then run triggers over the 1m candles since the last check."""
    risk = risk or {}
    bars_by_symbol = bars_by_symbol or {}
    checked = state.setdefault("checked", {})
    now_ts = datetime.now(timezone.utc).timestamp()
    for q in quotes:
        symbol = q["symbol"]
        bid, ask = inst.bid_ask(q)
        for p in state["positions"]:
            if p["symbol"] == symbol:
                p.update({"mark_price": float(q["price"]), "bid": bid, "ask": ask})
        if not inst.is_open(symbol):
            continue  # no fills while the market is shut; the open will show any gap
        last = float(checked.get(symbol, now_ts - 60))
        bars = [b for b in bars_by_symbol.get(symbol, []) if b["t"] + 60 > last]
        # The live quote acts as a final one-tick candle so nothing between the last bar and now is missed.
        bars.append({"t": now_ts, "o": float(q["price"]), "h": float(q["price"]), "l": float(q["price"])})
        for bar in bars:
            opened_before = {p["id"] for p in state["positions"] if p["symbol"] == symbol}
            _process_bar(state, symbol, bar, risk, opened_before)
        checked[symbol] = now_ts
    mark_state(state)
    _margin_close_out(state)
    return state


def _margin_close_out(state):
    used = float(state.get("used_margin") or 0)
    if used <= 0 or float(state["equity"]) >= inst.CLOSE_OUT_LEVEL * used:
        return
    for p in list(state["positions"]):
        qty = float(p["quantity"])
        side = "sell" if qty > 0 else "buy"
        px = float(p["bid"] if qty > 0 else p["ask"])
        fill_order(state, p["symbol"], side, abs(qty), px, reason="margin close-out (equity below 50% of margin)")
    state["margin_call"] = now()


# ── Manual closes ──────────────────────────────────────────────────────────

def close_position(state, symbol, reason="manual close", quote=None):
    pos = _position(state, symbol)
    if not pos:
        raise ValueError(f"No open position for {symbol}")
    if not inst.is_open(symbol):
        nxt = inst.next_open(symbol)
        raise ValueError(f"Market is closed. Opens {nxt.strftime('%a %H:%M UTC') if nxt else 'later'}.")
    qty = float(pos["quantity"])
    side = "sell" if qty > 0 else "buy"
    px = _taker_price(symbol, side, float(pos["mark_price"]), quote) if quote else float(pos["bid"] if qty > 0 else pos["ask"])
    return fill_order(state, symbol, side, abs(qty), px, reason=reason)


def close_all(state, quotes_by_symbol=None):
    quotes_by_symbol = quotes_by_symbol or {}
    skipped = []
    for order in state.get("orders", []):
        if order.get("status") in ("pending", "triggered"):
            order["status"] = "cancelled"
    for p in list(state.get("positions", [])):
        try:
            close_position(state, p["symbol"], "close all", quotes_by_symbol.get(p["symbol"]))
        except ValueError:
            skipped.append(p["symbol"])
    state["active"] = False
    mark_state(state)
    return skipped
