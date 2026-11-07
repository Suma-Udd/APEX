"""End to end check of the APEX backend with controllable fake prices.

Run from the project root:  python scripts/test-backend.py backend
"""
import os, sys, tempfile, time, random, math
from datetime import datetime, timezone
os.environ["APEX_DATA"] = tempfile.mkdtemp(); os.environ["APEX_TOKEN"] = "t"
sys.path.insert(0, sys.argv[1])
import modules.market_data as md
import modules.instruments as inst

PX = {"BTCUSDT": 50000.0, "ETHUSDT": 3000.0, "AAPL": 200.0, "EURUSD=X": 1.08, "GC=F": 2400.0}
MIN = {}
def q(sym):
    s = sym.upper(); p = PX[s]
    sp = 1.0 if s == "BTCUSDT" else 0.0
    return {"symbol": s, "market": md.market_for(s), "price": p, "bid": p - sp if sp else None, "ask": p + sp if sp else None,
            "change_pct": 0, "volume": 0, "timestamp": "", "source": "fake", "delayed": False}
def cand(sym, tf="1h", limit=300, period=None):
    r = random.Random(hash(sym) % 1000); p = PX.get(sym.upper(), 100) * 0.9; out = []; step = {"1m":60,"5m":300,"15m":900,"30m":1800,"1h":3600,"4h":14400,"1d":86400}.get(tf, 3600)
    now = int(time.time()) // step * step
    for i in range(limit):
        o = p; c = o * (1 + r.gauss(0, 0.006) + 0.004 * math.sin(i / 30))
        out.append({"t": now - (limit - 1 - i) * step, "o": o, "h": max(o, c) * 1.002, "l": min(o, c) * 0.998, "c": c, "v": 1}); p = c
    return {"symbol": sym, "timeframe": tf, "source": "fake", "delayed": False, "candles": out}
md.quote = q; md.candles = cand; md.minute_bars = lambda s, since: MIN.get(s.upper(), [])

# Pretend it's Wednesday 15:00 UTC (US market open) unless a test overrides it.
CLOCK = {"at": datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc)}
_real_is_open = inst.is_open
inst.is_open = lambda symbol, at=None: _real_is_open(symbol, at or CLOCK["at"])

import main
from fastapi.testclient import TestClient
c = TestClient(main.app); H = {"X-APEX-Token": "t"}
P = lambda path, j=None: c.post(path, json=j, headers=H)
G = lambda path: c.get(path, headers=H)
results = []
def check(name, ok, info=""):
    results.append((name, bool(ok))); print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""))
def state(): return G("/api/paper/state").json()

check("auth required", c.get("/api/paper/state").status_code == 401)
check("health", G("/api/health").json()["backend"] == "ok")
r = P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 0.1})
check("orders refused while engine paused", r.status_code == 409)
check("start engine", P("/api/paper/start").json()["active"] is True)
s0 = state(); check("starting balance", s0["equity"] == 100000, s0["equity"])

# market buy
r = P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 1, "stop_loss": 48000, "take_profit": 55000}).json()
o = r["order"]; check("market buy fills at ask + 1bp", abs(o["filled_price"] - 50001 * 1.0001) < 0.01, o["filled_price"])
check("crypto fee 0.10%", abs(o["trade"]["fee"] - o["filled_price"] * 0.001) < 0.01, o["trade"]["fee"])
st = r["portfolio"]; check("margin used = notional / 2", abs(st["used_margin"] - 50000 * 1 / 2) < 100, st["used_margin"])
up0 = st["positions"][0]["unrealized_pnl"]; check("spread cost shows right after fill", up0 < 0, up0)
PX["BTCUSDT"] = 51000; st = P("/api/paper/refresh").json()["portfolio"]
pos = st["positions"][0]; check("long P&L marks at bid", abs(pos["unrealized_pnl"] - ((50999) - o["filled_price"])) < 1, pos["unrealized_pnl"])
r = P("/api/paper/positions/BTCUSDT/levels", {"stop_loss": 50500, "take_profit": 56000})
check("move SL/TP (chart drag)", r.status_code == 200 and state()["positions"][0]["stop_loss"] == 50500)
check("SL above price refused", P("/api/paper/positions/BTCUSDT/levels", {"stop_loss": 52000}).status_code == 400)
# take profit hit via 1m bar
MIN["BTCUSDT"] = [{"t": time.time() - 20, "o": 51000, "h": 56100, "l": 50900, "c": 55500}]; PX["BTCUSDT"] = 55500
st = P("/api/paper/refresh").json()["portfolio"]; MIN["BTCUSDT"] = []
t = st["trades"][-1]; check("take profit fills at target", not st["positions"] and abs(t["price"] - 56000) < 0.01, f'{t.get("reason")} @ {t["price"]} pnl {t.get("realized_pnl")}')
check("realized profit booked", st["balance"] > 100000, round(st["balance"], 2))

# short + stop loss gap
PX["BTCUSDT"] = 50000
r = P("/api/paper/order", {"symbol": "BTCUSDT", "side": "sell", "quantity": 0.5, "stop_loss": 51000}).json()
check("short fills at bid - 1bp", abs(r["order"]["filled_price"] - 49999 * 0.9999) < 0.01, r["order"]["filled_price"])
MIN["BTCUSDT"] = [{"t": time.time() - 20, "o": 51500, "h": 51800, "l": 51400, "c": 51600}]; PX["BTCUSDT"] = 51600
st = P("/api/paper/refresh").json()["portfolio"]; MIN["BTCUSDT"] = []
t = st["trades"][-1]; check("stop gapped over fills at the open (worse)", not st["positions"] and t["price"] >= 51500, f'{t.get("reason")} @ {t["price"]}')

# limit, stop, stop-limit, cancel
PX["BTCUSDT"] = 50000
r = P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "type": "limit", "limit_price": 49000, "quantity": 0.2}).json()
check("limit order goes pending", r["order"]["status"] == "pending")
MIN["BTCUSDT"] = [{"t": time.time() - 20, "o": 49500, "h": 49600, "l": 48900, "c": 49200}]; PX["BTCUSDT"] = 49200
st = P("/api/paper/refresh").json()["portfolio"]; MIN["BTCUSDT"] = []
pos = next((p for p in st["positions"] if p["symbol"] == "BTCUSDT"), None)
check("limit fills at limit price when touched", pos and abs(pos["avg_price"] - 49000) < 0.01, pos and pos["avg_price"])
r = P("/api/paper/order", {"symbol": "ETHUSDT", "side": "buy", "type": "stop", "stop_price": 3100, "quantity": 1}).json()
check("stop order pending", r["order"]["status"] == "pending")
PX["ETHUSDT"] = 3150; st = P("/api/paper/refresh").json()["portfolio"]
check("buy stop triggers above", any(p["symbol"] == "ETHUSDT" for p in st["positions"]))
r = P("/api/paper/order", {"symbol": "ETHUSDT", "side": "sell", "type": "stop_limit", "stop_price": 3000, "limit_price": 2990, "quantity": 1}).json()
oid = r["order"]["id"]; check("stop-limit pending", r["order"]["status"] == "pending")
check("cancel order", c.delete(f"/api/paper/orders/{oid}", headers=H).status_code == 200 and not any(o["id"] == oid and o["status"] == "pending" for o in state()["orders"]))
r = P("/api/paper/positions/ETHUSDT/close").json()
check("close one position", not any(p["symbol"] == "ETHUSDT" for p in r["portfolio"]["positions"]))

# forex, gold, stocks open hours
r = P("/api/paper/order", {"symbol": "EURUSD=X", "side": "buy", "quantity": 10000})
check("forex market order (open hours)", r.status_code == 200, r.json().get("detail", ""))
r = P("/api/paper/order", {"symbol": "AAPL", "side": "buy", "quantity": 10})
check("AAPL during NY session", r.status_code == 200, r.json().get("detail", ""))
if r.status_code == 200: check("stock fee $1 minimum", abs(r.json()["order"]["trade"]["fee"] - 1.0) < 1e-6, r.json()["order"]["trade"]["fee"])
CLOCK["at"] = datetime(2026, 11, 7, 16, 0, tzinfo=timezone.utc)  # Saturday
r = P("/api/paper/order", {"symbol": "AAPL", "side": "buy", "quantity": 1})
check("AAPL refused on Saturday", r.status_code == 400, r.json().get("detail", "")[:70])
r = P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 0.01})
check("crypto still trades on Saturday", r.status_code == 200)
CLOCK["at"] = datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc)
st = P("/api/paper/close-all").json(); st = st.get("portfolio", st)
check("close all (also pauses engine)", not st["positions"] and st["active"] is False, st.get("skipped")); P("/api/paper/start")

# margin
r = P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 10})
check("too big for margin refused", r.status_code == 400, r.json().get("detail", "")[:80])

# risk limits
P("/api/risk", {"risk_pct": 1, "max_drawdown_pct": 25, "max_open_positions": 1, "daily_loss_limit_pct": 10})
P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 0.01})
r = P("/api/paper/order", {"symbol": "ETHUSDT", "side": "buy", "quantity": 0.1})
check("max open positions enforced", r.status_code == 400, r.json().get("detail", "")[:70])
P("/api/paper/close-all"); P("/api/paper/reset"); P("/api/paper/start")
P("/api/risk", {"risk_pct": 1, "max_drawdown_pct": 25, "max_open_positions": 5, "daily_loss_limit_pct": 0.5})
PX["BTCUSDT"] = 50000; P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 1.5})
PX["BTCUSDT"] = 49000; st = P("/api/paper/refresh").json()["portfolio"]
check("daily loss limit halts trading", st.get("risk_halt"), st.get("risk_halt"))
r = P("/api/paper/order", {"symbol": "ETHUSDT", "side": "buy", "quantity": 0.1})
check("new orders blocked while halted", r.status_code == 400, r.json().get("detail", "")[:70])
r = P("/api/paper/positions/BTCUSDT/close"); check("closing still allowed while halted", r.status_code == 200)
P("/api/paper/reset"); P("/api/paper/start")
P("/api/risk", {"risk_pct": 1, "max_drawdown_pct": 1, "max_open_positions": 5, "daily_loss_limit_pct": 10})
PX["BTCUSDT"] = 50000; P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 1.5})
PX["BTCUSDT"] = 49000; st = P("/api/paper/refresh").json()["portfolio"]
check("max drawdown halts trading", st.get("risk_halt") and "drawdown" in st["risk_halt"], st.get("risk_halt"))
P("/api/paper/close-all")

# reset + margin close-out
r = P("/api/paper/reset"); P("/api/paper/start")
st = state(); check("reset account", st["equity"] == 100000 and not st["positions"] and not st["trades"], st["equity"])
P("/api/risk", {"risk_pct": 1, "max_drawdown_pct": 25, "max_open_positions": 5, "daily_loss_limit_pct": 10})
PX["BTCUSDT"] = 50000; P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 3.8})
PX["BTCUSDT"] = 28000; st = P("/api/paper/refresh").json()["portfolio"]
check("margin close-out below 50%", not st["positions"], f'equity {round(st["equity"])} last: {st["trades"][-1].get("reason") if st["trades"] else None}')
P("/api/paper/reset"); P("/api/paper/start"); PX["BTCUSDT"] = 50000

# strategies + backtests
strats = G("/api/strategies").json(); lst = strats["built_in"]
check("10 strategies listed", len(lst) >= 10, len(lst))
bad = []
for s in lst:
    r = P("/api/backtest", {"strategy_id": s["id"], "symbol": "BTCUSDT", "timeframe": "1h"})
    if r.status_code != 200 or r.json().get("status") != "completed": bad.append((s["id"], r.status_code, r.text[:80]))
check("backtest runs for every strategy", not bad, bad)
r = P("/api/strategies/custom", {"name": "My EMA copy", "source_id": lst[0]["id"]}); cid = r.json().get("id") or r.json().get("strategy", {}).get("id")
r2 = P("/api/backtest", {"strategy_id": cid, "symbol": "BTCUSDT", "timeframe": "1h"})
check("custom copy backtests", r2.status_code == 200 and r2.json().get("status") == "completed", r2.text[:80])
for s_ in lst: print("   ", s_["id"], P("/api/backtest", {"strategy_id": s_["id"], "symbol": "BTCUSDT", "timeframe": "1h"}).json().get("trades"), "trades")

# AI Auto engine with a manual setup (no AI key needed for the step itself)
mode = {"mode": "ai_auto", "setup": {"symbol": "BTCUSDT", "timeframe": "1h", "strategy_id": lst[0]["id"], "parameters": {k: v.get("default") for k, v in lst[0].get("parameters", {}).items()}}}
main.state_put("operation_mode", mode)
r = P("/api/paper/strategy-step"); check("auto step runs", r.status_code == 200, r.json().get("note"))
r = P("/api/paper/strategy-step"); check("auto step once per candle", "Waiting" in r.json().get("note", ""), r.json().get("note"))
P("/api/mode", {"mode": "ai_setup"})
check("orders blocked in AI Setup mode", P("/api/paper/order", {"symbol": "BTCUSDT", "side": "buy", "quantity": 0.01}).status_code == 403)
P("/api/mode", {"mode": "manual"})
check("AI setup asks for a key when none set", P("/api/ai/strategy-setup", {"symbol": "BTCUSDT", "strategy_id": lst[0]["id"]}).status_code == 400)

# market endpoints
check("quote endpoint", G("/api/market/quote?symbol=BTCUSDT").status_code == 200)
r = G("/api/market/candles?symbol=BTCUSDT&timeframe=4h"); check("candles endpoint", r.status_code == 200 and len(r.json()["candles"]) > 50)
check("logs", G("/api/logs").status_code == 200)

# persistence: new app instance on same data dir
st_before = state()
import importlib; importlib.reload(main)
with TestClient(main.app) as c2:
    s2 = c2.get("/api/paper/state", headers=H).json()
check("account survives restart, engine starts paused", s2["equity"] == st_before["equity"] and s2["active"] is False, (s2["equity"], s2["active"]))

print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed")
