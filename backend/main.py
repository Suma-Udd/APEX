"""APEX local backend: strategy registry, paper-account state and OpenAI-compatible AI."""
import argparse
import json
import math
import os
import random
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from copy import deepcopy
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from modules.strategy_library import all_builtin, get_builtin
from modules.paper_engine import empty_state, mark_state, migrate, close_all, close_position, submit_order, update_quotes, risk_check, record_equity
from modules import market_data, instruments, signals
from modules import backtest as backtest_engine
from modules import lesson as lesson_engine

TOKEN = os.environ.get("APEX_TOKEN", "dev")


def default_data_dir() -> Path:
    """Per-user app data folder on every OS (the Tauri shell normally passes APEX_DATA)."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "APEX"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "APEX"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "APEX"


DATA = Path(os.environ.get("APEX_DATA") or default_data_dir())
CONFIG_FILE = DATA / "config" / "openai.json"
DEFAULT_BASE_URL = "http://127.0.0.1:31415/v1"
SUBDIRS = ["config", "database", "market_data", "strategies", "experiments", "logs", "cache", "backups"]
for directory in SUBDIRS:
    (DATA / directory).mkdir(parents=True, exist_ok=True)

# FastAPI runs sync endpoints in a thread pool. One lock serialises every
# read-modify-write of the paper portfolio so two requests can't overwrite
# each other's trades (the quote poller used to wipe out fresh orders).
LOCK = threading.RLock()
db = sqlite3.connect(DATA / "database" / "apex.db", check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript("""
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS layouts(name TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS strategies(id INTEGER PRIMARY KEY, name TEXT, version INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS experiments(id INTEGER PRIMARY KEY, title TEXT, status TEXT, json TEXT);
CREATE TABLE IF NOT EXISTS paper_trades(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, side TEXT, qty REAL, price REAL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, ts REAL, event TEXT);
CREATE TABLE IF NOT EXISTS custom_strategies(id TEXT PRIMARY KEY, name TEXT, version INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY, json TEXT);
""")
db.commit()


def query(sql: str, args=()):
    with LOCK:
        return db.execute(sql, args).fetchall()


def execute(sql: str, args=()):
    with LOCK:
        db.execute(sql, args)
        db.commit()


def log(event: str):
    execute("INSERT INTO audit_log(ts,event) VALUES(?,?)", (time.time(), event))
    with open(DATA / "logs" / "apex.log", "a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {event}\n")


def auth(x_apex_token: str = Header(default="")):
    if x_apex_token != TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_app):
    # Safety: a running paper engine never resumes automatically after an app restart.
    state = migrate(state_get("paper", empty_state()))
    state["active"] = False
    state_put("paper", state)
    stop = threading.Event()
    worker = threading.Thread(target=background_loop, args=(stop,), name="apex-engine", daemon=True)
    worker.start()
    yield
    stop.set()


app = FastAPI(title="APEX Local Backend", dependencies=[Depends(auth)], lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-APEX-Token"],
)


def _one(sql: str, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


def state_get(key: str, fallback):
    rows = query("SELECT json FROM app_state WHERE key=?", (key,))
    row = rows[0] if rows else None
    if not row:
        return deepcopy(fallback)
    try:
        return json.loads(row["json"])
    except (ValueError, TypeError):
        return deepcopy(fallback)


def state_put(key: str, value):
    execute("INSERT INTO app_state(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json", (key, json.dumps(value)))


def get_paper_state():
    return mark_state(migrate(state_get("paper", empty_state())))




def save_paper_state(state):
    state_put("paper", state)
    return state


class AISettingsIn(BaseModel):
    base_url: str = Field(default=DEFAULT_BASE_URL, min_length=8, max_length=500)
    api_key: Optional[str] = None
    model: str = Field(default="auto", min_length=1, max_length=200)
    clear_api_key: bool = False


def read_ai_settings():
    if not CONFIG_FILE.exists():
        return {"base_url": DEFAULT_BASE_URL, "model": "auto", "api_key": ""}
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return {"base_url": str(raw.get("base_url") or DEFAULT_BASE_URL), "model": str(raw.get("model") or "auto"), "api_key": str(raw.get("api_key") or "")}
    except (OSError, ValueError, TypeError):
        raise HTTPException(status_code=500, detail="Could not read AI configuration")


def write_ai_settings(settings):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(CONFIG_FILE), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(settings, handle)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


def provider_request(path: str, method="GET", payload=None):
    settings = read_ai_settings()
    if not settings["api_key"]:
        raise HTTPException(status_code=400, detail="Add your API key in AI Settings first")
    base = settings["base_url"].strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="API Base URL must start with http:// or https://")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(base + path, data=body, method=method, headers={
        "Authorization": f"Bearer {settings['api_key']}", "Content-Type": "application/json", "Accept": "application/json"
    })
    try:
        with urllib.request.urlopen(request, timeout=90, context=market_data.SSL_CONTEXT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise HTTPException(status_code=502, detail="AI provider rejected the API key")
        if exc.code == 404:
            raise HTTPException(status_code=502, detail="AI endpoint not found; check the Base URL")
        raise HTTPException(status_code=502, detail=f"AI provider returned HTTP {exc.code}")
    except (urllib.error.URLError, TimeoutError, OSError):
        raise HTTPException(status_code=502, detail="Could not connect to the AI provider")
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=502, detail="AI provider returned an invalid response")


@app.get("/api/health")
def health():
    configured = bool(read_ai_settings()["api_key"])
    return {"backend": "ok", "market_data": "Public market data adapters (Binance/Yahoo Finance)", "ai": "configured" if configured else "not configured", "ai_configured": configured, "paper_mode": True}


@app.get("/api/ai/settings")
def get_ai_settings():
    s = read_ai_settings()
    return {"base_url": s["base_url"], "model": s["model"], "api_key_set": bool(s["api_key"])}


@app.post("/api/ai/settings")
def save_ai_settings(body: AISettingsIn):
    base = body.base_url.strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="API Base URL must start with http:// or https://")
    old = read_ai_settings()
    key = "" if body.clear_api_key else (body.api_key.strip() if body.api_key and body.api_key.strip() else old["api_key"])
    write_ai_settings({"base_url": base, "model": body.model.strip(), "api_key": key})
    log("AI provider settings updated")
    return {"saved": True, "api_key_set": bool(key), "base_url": base, "model": body.model.strip()}


@app.post("/api/ai/test")
def test_ai_connection():
    result = provider_request("/models")
    models = result.get("data", []) if isinstance(result, dict) else []
    return {"ok": True, "models": [str(x.get("id")) for x in models[:30] if isinstance(x, dict) and x.get("id")]}


@app.get("/api/strategies")
def list_strategies():
    builtins = all_builtin()
    rows = query("SELECT json FROM custom_strategies ORDER BY name")
    custom = [json.loads(r["json"]) for r in rows]
    return {"built_in": builtins, "custom": custom}


@app.get("/api/strategies/{strategy_id}")
def strategy_detail(strategy_id: str):
    item = get_builtin(strategy_id)
    if item:
        return item
    row = _one("SELECT json FROM custom_strategies WHERE id=?", (strategy_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return json.loads(row["json"])


class StrategyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="User-defined strategy", max_length=1000)
    source_id: Optional[str] = None


@app.post("/api/strategies/custom")
def create_custom_strategy(body: StrategyCreate):
    base = get_builtin(body.source_id) if body.source_id else None
    if body.source_id and not base:
        row = _one("SELECT json FROM custom_strategies WHERE id=?", (body.source_id,))
        base = json.loads(row["json"]) if row else None
    if body.source_id and not base:
        raise HTTPException(status_code=404, detail="Source strategy not found")
    item = base or {"category": "Custom", "markets": ["Forex", "Crypto"], "timeframes": ["15m", "1h", "4h"], "indicators": [], "entry": [], "exit": [], "risk": {"default_risk_pct": 0.25, "max_positions": 1, "stop_loss": "User-defined", "take_profit": "User-defined"}, "parameters": {}, "limitations": []}
    item = deepcopy(item)
    base_id = (base or {}).get("base_id") or (base or {}).get("id")
    item.update({"id": f"custom-{int(time.time() * 1000)}", "name": body.name.strip(), "description": body.description, "custom": True, "version": 1, "base_id": base_id})
    execute("INSERT INTO custom_strategies(id,name,version,json) VALUES(?,?,?,?)", (item["id"], item["name"], 1, json.dumps(item)))
    log(f"Custom strategy created: {item['id']}")
    return item


@app.get("/api/strategies/{strategy_id}/parameters")
def get_strategy_parameters(strategy_id: str):
    strategy = get_builtin(strategy_id)
    if not strategy:
        row = _one("SELECT json FROM custom_strategies WHERE id=?", (strategy_id,))
        strategy = json.loads(row["json"]) if row else None
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")
    defaults = {key: spec.get("default") for key, spec in strategy.get("parameters", {}).items()}
    saved = state_get(f"strategy-parameters:{strategy_id}", defaults)
    return {"strategy_id": strategy_id, "parameters": saved, "schema": strategy.get("parameters", {})}


class StrategyParametersIn(BaseModel):
    parameters: dict


@app.post("/api/strategies/{strategy_id}/parameters")
def save_strategy_parameters(strategy_id: str, body: StrategyParametersIn):
    strategy = get_builtin(strategy_id)
    if not strategy:
        row = _one("SELECT json FROM custom_strategies WHERE id=?", (strategy_id,))
        strategy = json.loads(row["json"]) if row else None
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")
    schema = strategy.get("parameters", {})
    clean = {}
    for key, value in body.parameters.items():
        if key not in schema:
            raise HTTPException(status_code=400, detail=f"Unknown strategy parameter: {key}")
        spec = schema[key]
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise HTTPException(status_code=400, detail=f"Parameter {key} must be numeric")
        if value < spec.get("min", value) or value > spec.get("max", value):
            raise HTTPException(status_code=400, detail=f"Parameter {key} is outside its allowed range")
        clean[key] = value
    current = get_strategy_parameters(strategy_id)["parameters"]
    current.update(clean)
    state_put(f"strategy-parameters:{strategy_id}", current)
    log(f"Strategy parameters updated: {strategy_id}")
    return {"strategy_id": strategy_id, "parameters": current}


@app.get("/api/risk")
def get_risk():
    return current_risk()


class RiskIn(BaseModel):
    risk_pct: float = Field(ge=0.05, le=2.0)
    max_drawdown_pct: float = Field(ge=0.5, le=25.0)
    max_open_positions: int = Field(ge=1, le=20)
    daily_loss_limit_pct: float = Field(ge=0.25, le=10.0)


@app.post("/api/risk")
def save_risk(body: RiskIn):
    data = body.model_dump()
    state_put("risk", data)
    log("Risk settings updated")
    return data


class ModeIn(BaseModel):
    mode: str = Field(pattern="^(ai_auto|ai_setup|manual)$")


@app.get("/api/mode")
def get_mode():
    return state_get("operation_mode", {"mode": "manual", "setup": None})


@app.post("/api/mode")
def set_mode(body: ModeIn):
    current = state_get("operation_mode", {"mode": "manual", "setup": None})
    previous_mode = current.get("mode")
    current["mode"] = body.mode
    if body.mode == "manual" or previous_mode == "manual":
        current["setup"] = None
        current.pop("last_candle", None)
    state_put("operation_mode", current)
    log(f"Operating mode changed: {body.mode}")
    return current


class SetupIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=30)
    timeframe: str = "1h"
    strategy_id: str = "trend-following-ema"


def load_strategy(strategy_id: str):
    strategy = get_builtin(strategy_id)
    if not strategy:
        row = _one("SELECT json FROM custom_strategies WHERE id=?", (strategy_id,))
        strategy = json.loads(row["json"]) if row else None
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return strategy


def engine_id(strategy):
    """Custom copies run the signal engine of the built-in they were copied from."""
    sid = strategy["id"]
    return sid if sid in signals.REGISTRY else strategy.get("base_id")


def closed_candles(symbol, timeframe, limit=500):
    data = market_data.candles(symbol, timeframe, limit)
    bars = data.get("candles", [])
    # Drop the candle that is still forming; signals only ever use finished candles.
    step = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}.get(timeframe, 3600)
    if bars and bars[-1]["t"] + step > time.time():
        bars = bars[:-1]
    return data, bars


def clean_params(schema, raw):
    out = {}
    for key, spec in schema.items():
        if key not in raw:
            out[key] = spec.get("default")
            continue
        v = float(raw[key])
        if spec.get("type") == "integer":
            v = int(round(v))
        if v < spec.get("min", v) or v > spec.get("max", v):
            raise ValueError(f"{key}={v} outside {spec.get('min')}..{spec.get('max')}")
        out[key] = v
    return out


@app.post("/api/ai/strategy-setup")
def ai_strategy_setup(body: SetupIn):
    """AI picks parameters for the selected strategy; APEX validates them and plots the current setup."""
    strategy = load_strategy(body.strategy_id)
    eid = engine_id(strategy)
    if not eid:
        raise HTTPException(status_code=501, detail="This strategy has no signal engine")
    settings = read_ai_settings()
    if not settings["api_key"]:
        raise HTTPException(status_code=400, detail="Connect an AI provider in Settings first")
    symbol = body.symbol.strip().upper()
    try:
        data, bars = closed_candles(symbol, body.timeframe, 500)
        q = market_data.quote(symbol)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not load market data: {str(exc)[:180]}")
    if len(bars) < 120:
        raise HTTPException(status_code=422, detail="Not enough history to evaluate this setup")
    schema = strategy.get("parameters", {})
    closes = [round(float(x["c"]), 8) for x in bars[-120:]]
    prompt = {
        "task": f"Choose conservative parameters for the '{strategy['name']}' strategy for the current market regime. This is research, not a prediction.",
        "strategy": {k: strategy.get(k) for k in ("description", "entry", "exit", "limitations")},
        "symbol": symbol, "timeframe": body.timeframe, "current_price": q["price"],
        "recent_closes_oldest_first": closes,
        "allowed_parameters": schema,
        "constraints": ["Use values inside the min/max ranges", "Integers for integer parameters",
                        "Do not claim profitability", "Return strict JSON only"],
        "required_json": {**{k: v.get("default") for k, v in schema.items()}, "reason": "one or two sentences"},
    }
    result = provider_request("/chat/completions", method="POST", payload={
        "model": settings["model"], "temperature": 0.1,
        "messages": [
            {"role": "system", "content": "You are a quantitative research assistant. Analyze only the supplied data. Return one JSON object, no markdown. Never claim certainty."},
            {"role": "user", "content": json.dumps(prompt)},
        ],
    })
    try:
        content = result["choices"][0]["message"]["content"]
        if isinstance(content, list):
            content = "\n".join(x.get("text", "") for x in content if isinstance(x, dict))
        content = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        chosen = json.loads(content)
        params = clean_params(schema, chosen)
        if "fast_ema" in params and params["slow_ema"] <= params["fast_ema"] + 1:
            raise ValueError("slow_ema must be at least 2 above fast_ema")
        if "macd_fast" in params and params["macd_slow"] <= params["macd_fast"]:
            raise ValueError("macd_slow must exceed macd_fast")
        if "fast" in params and "slow" in params and params["slow"] <= params["fast"]:
            raise ValueError("slow must exceed fast")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI returned an invalid setup: {str(exc)[:160]}")

    risk = current_risk()
    replay = backtest_engine.run(eid, bars, params, symbol, body.timeframe, 10000, risk["risk_pct"], base_id=strategy.get("base_id"))
    op = replay.get("open_position")
    price = float(q["price"])
    if op:
        direction = "LONG BIAS" if op["direction"] > 0 else "SHORT BIAS"
        entry, stop, target = op["entry"], op["stop"], op["take_profit"]
    else:
        direction, entry, stop, target = "FLAT", price, None, None
    setup = {"strategy_id": strategy["id"], "strategy_name": strategy["name"], "engine_id": eid, "parameters": params,
             "reason": str(chosen.get("reason", "AI-selected from recent market data"))[:500],
             "symbol": symbol, "timeframe": body.timeframe, "direction": direction,
             "entry": round(entry, 8), "stop_loss": round(stop, 8) if stop else None, "take_profit": round(target, 8) if target else None,
             "in_trade_since": op["since"] if op else None,
             "backtest": {k: replay.get(k) for k in ("trades", "win_rate_pct", "return_pct", "max_drawdown_pct", "profit_factor")},
             "data_source": data.get("source"), "delayed": data.get("delayed", True), "created_at": time.time()}
    with LOCK:
        mode = state_get("operation_mode", {"mode": "manual", "setup": None})
        mode["setup"] = setup
        mode.pop("last_candle", None)
        mode.pop("strategy_state", None)
        state_put("operation_mode", mode)
        state_put(f"strategy-parameters:{strategy['id']}", params)
    log(f"AI setup for {symbol} {body.timeframe}: {strategy['name']} {params} -> {direction}")
    return setup


DEFAULT_RISK = {"risk_pct": 0.5, "max_drawdown_pct": 5.0, "max_open_positions": 3, "daily_loss_limit_pct": 2.0}


def current_risk():
    return {**DEFAULT_RISK, **state_get("risk", DEFAULT_RISK)}


def with_risk_status(state):
    """Attach live risk/margin status so the UI can show why trading is blocked."""
    state["risk_halt"] = risk_check(state, current_risk())
    return state


def open_symbols(state):
    symbols = {p["symbol"] for p in state.get("positions", [])}
    symbols.update(o["symbol"] for o in state.get("orders", []) if o.get("status") in ("pending", "triggered"))
    return symbols


def fetch_market(symbols, state=None):
    """Quotes plus the 1m candles since each symbol was last checked."""
    checked = (state or {}).get("checked", {})
    quotes, bars, errors = [], {}, []
    for symbol in symbols:
        try:
            quotes.append(market_data.quote(symbol))
        except Exception as exc:
            errors.append(f"{symbol}: {str(exc)[:100]}")
            continue
        try:
            bars[symbol] = market_data.minute_bars(symbol, float(checked.get(symbol, time.time() - 60)))
        except Exception:
            bars[symbol] = []  # the live quote still gets checked
    return quotes, bars, errors


def apply_market(symbols):
    """Fetch prices outside the lock, then mark/trigger inside it."""
    quotes, bars, errors = fetch_market(symbols, get_paper_state())
    with LOCK:
        state = get_paper_state()
        before = {t["id"] for t in state["trades"]}
        update_quotes(state, quotes, bars, current_risk())
        record_equity(state)
        save_paper_state(state)
    for t in state["trades"]:
        if t["id"] not in before:
            log(f"{t['reason'].capitalize()}: {t['side'].upper()} {t['quantity']:g} {t['symbol']} @ {t['price']:g} (P&L {t['realized_pnl']:+,.2f})")
    return state, quotes, errors


# ── Live strategy runner (backend-side, so the bot doesn't depend on the UI) ──

def strategy_step():
    """Evaluate the auto strategy on the newest closed candle and trade the paper account."""
    mode = state_get("operation_mode", {"mode": "manual", "setup": None})
    setup = mode.get("setup")
    if mode.get("mode") != "ai_auto" or not setup:
        return {"signal": "none", "note": "Auto mode is off"}
    if not get_paper_state().get("active"):
        return {"signal": "none", "note": "Engine paused"}
    symbol, tf = setup["symbol"], setup["timeframe"]
    if not instruments.is_open(symbol):
        return {"signal": "none", "note": f"{symbol} market closed"}
    strategy = load_strategy(setup["strategy_id"])
    eid = setup.get("engine_id") or engine_id(strategy)
    _, bars = closed_candles(symbol, tf, 500)
    if len(bars) < 60:
        return {"signal": "none", "note": "Not enough candles"}
    candle_id = int(bars[-1]["t"])
    if mode.get("last_candle") == candle_id:
        return {"signal": "none", "note": "Waiting for the next candle to close"}

    q = market_data.quote(symbol)
    price = float(q["price"])
    risk = current_risk()
    first_run = mode.get("last_candle") is None
    strat = signals.build(eid, bars, setup["parameters"], instruments.spec(symbol)["half_spread_bps"], strategy.get("base_id"))
    if isinstance(strat, signals.BoundedGrid) and mode.get("strategy_state", {}).get("range"):
        strat.range = tuple(mode["strategy_state"]["range"])

    with LOCK:
        state = get_paper_state()
        pos = next((p for p in state["positions"] if p["symbol"] == symbol), None)
        qty_now = float(pos["quantity"]) if pos else 0.0
        if strat.sizing == "notional":
            cur = qty_now * price / max(state["equity"] * strat.max_exposure_pct / 100, 1e-9)
        else:
            cur = (1 if qty_now > 0 else -1) if qty_now else 0
        sig = strat.decide(len(bars) - 1, round(cur, 6) if strat.sizing == "notional" else cur)

        # First run of a new session: join a trade the strategy is already in, if its stop hasn't been hit.
        if first_run and sig is None and not pos:
            replay = backtest_engine.run(eid, bars, setup["parameters"], symbol, tf, 10000, risk["risk_pct"], base_id=strategy.get("base_id"))
            op = replay.get("open_position")
            if op and (op["stop"] is None or (op["direction"] > 0 and price > op["stop"]) or (op["direction"] < 0 and price < op["stop"])):
                if not (op["take_profit"] and ((op["direction"] > 0 and price >= op["take_profit"]) or (op["direction"] < 0 and price <= op["take_profit"]))):
                    sig = signals.Signal(op["fraction"] if strat.sizing == "notional" else op["direction"], op["stop"], op["take_profit"], "joined the strategy's current trade")

        mode["last_candle"] = candle_id
        if isinstance(strat, signals.BoundedGrid):
            mode["strategy_state"] = {"range": list(strat.range) if strat.range else None}
        state_put("operation_mode", mode)

        orders = []
        note = "No signal on this candle"
        if sig is not None:
            try:
                if strat.sizing == "notional":
                    want = sig.target * state["equity"] * strat.max_exposure_pct / 100 / price
                    delta = want - qty_now
                    if abs(delta) * price >= 1:
                        orders.append(submit_order(state, {"symbol": symbol, "side": "buy" if delta > 0 else "sell", "type": "market", "quantity": abs(delta)}, q, risk))
                else:
                    target = sig.target
                    if qty_now and (target == 0 or (target > 0) != (qty_now > 0)):
                        orders.append(submit_order(state, {"symbol": symbol, "side": "sell" if qty_now > 0 else "buy", "type": "market", "quantity": abs(qty_now)}, q, risk))
                        qty_now = 0
                    if target != 0 and qty_now == 0:
                        dist = abs(price - sig.stop) if sig.stop else price * 0.01
                        units = (state["equity"] * risk["risk_pct"] / 100) / max(dist, price * 1e-5)
                        units = min(units, max(0.0, state["free_margin"]) * instruments.spec(symbol)["leverage"] * 0.95 / price)
                        side = "buy" if target > 0 else "sell"
                        # Keep the signal's stop/target but make sure they're on the right side of the live price.
                        sl = sig.stop if sig.stop and ((side == "buy" and sig.stop < price) or (side == "sell" and sig.stop > price)) else None
                        tp = sig.take_profit if sig.take_profit and ((side == "buy" and sig.take_profit > price) or (side == "sell" and sig.take_profit < price)) else None
                        if units > 0:
                            orders.append(submit_order(state, {"symbol": symbol, "side": side, "type": "market", "quantity": float(f"{units:.6g}"),
                                                               "stop_loss": sl, "take_profit": tp}, q, risk))
                note = sig.reason
            except ValueError as exc:
                note = f"Signal skipped: {exc}"
        record_equity(state)
        save_paper_state(state)
    if sig is not None:
        log(f"Auto {strategy['name']} on {symbol}: {note}" + (f" ({len(orders)} order{'s' if len(orders) != 1 else ''})" if orders else ""))
    return {"signal": "none" if sig is None else ("long" if sig.target > 0 else "short" if sig.target < 0 else "flat"),
            "orders": orders, "note": note, "portfolio": with_risk_status(state), "checked_at": time.time()}


@app.post("/api/paper/strategy-step")
def paper_strategy_step():
    try:
        return strategy_step()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Strategy step failed: {str(exc)[:200]}")


_last_error = {"t": 0.0}


def background_loop(stop_event):
    """Runs while the app is open: keeps positions marked, fills orders, and runs Auto mode."""
    while not stop_event.wait(15):
        try:
            state = get_paper_state()
            if not state.get("active"):
                continue
            symbols = open_symbols(state)
            if symbols:
                apply_market(symbols)
            mode = state_get("operation_mode", {"mode": "manual"})
            if mode.get("mode") == "ai_auto" and mode.get("setup"):
                strategy_step()
        except Exception as exc:  # never let the loop die; log at most once every 5 minutes
            if time.time() - _last_error["t"] > 300:
                _last_error["t"] = time.time()
                log(f"Background engine error: {str(exc)[:200]}")


# ── Paper account endpoints ───────────────────────────────────────────────

@app.get("/api/paper/state")
def paper_state():
    return with_risk_status(get_paper_state())


@app.post("/api/paper/start")
def paper_start():
    with LOCK:
        state = get_paper_state()
        state["active"] = True
        state["checked"] = {}  # don't replay candles from while the engine was off
        state["feed"] = "Public market data · local paper execution"
        save_paper_state(state)
        mode = state_get("operation_mode", {"mode": "manual"})
        mode.pop("last_candle", None)
        state_put("operation_mode", mode)
    log("Paper engine started")
    return with_risk_status(state)


@app.post("/api/paper/pause")
def paper_pause():
    with LOCK:
        state = get_paper_state()
        state["active"] = False
        save_paper_state(state)
    log("Paper engine paused")
    return with_risk_status(state)


@app.post("/api/paper/reset")
def paper_reset():
    with LOCK:
        state = empty_state()
        save_paper_state(state)
        mode = state_get("operation_mode", {"mode": "manual", "setup": None})
        mode.pop("last_candle", None)
        state_put("operation_mode", mode)
    log("Paper account reset to $100,000")
    return with_risk_status(state)


@app.post("/api/paper/close-all")
def paper_close_all():
    quotes, bars, _ = fetch_market(open_symbols(get_paper_state()), get_paper_state())
    with LOCK:
        state = get_paper_state()
        update_quotes(state, quotes, bars, current_risk())
        skipped = close_all(state, {q["symbol"]: q for q in quotes})
        record_equity(state)
        save_paper_state(state)
    log("Close all: positions closed, working orders cancelled" + (f" (market closed for {', '.join(skipped)})" if skipped else ""))
    return {**with_risk_status(state), "skipped": skipped}


@app.post("/api/paper/positions/{symbol}/close")
def paper_close_position(symbol: str):
    symbol = symbol.strip().upper()
    quotes, bars, _ = fetch_market([symbol], get_paper_state())
    with LOCK:
        state = get_paper_state()
        update_quotes(state, quotes, bars, current_risk())
        try:
            trade = close_position(state, symbol, quote=quotes[0] if quotes else None)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        record_equity(state)
        save_paper_state(state)
    log(f"Position closed: {symbol} @ {trade['price']:g} (P&L {trade['realized_pnl']:+,.2f})")
    return {"trade": trade, "portfolio": with_risk_status(state)}


class OrderIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=30)
    side: str = Field(pattern="^(buy|sell)$")
    type: str = Field(default="market", pattern="^(market|limit|stop|stop_limit)$")
    quantity: float = Field(gt=0, le=100000000)
    limit_price: Optional[float] = Field(default=None, gt=0)
    stop_price: Optional[float] = Field(default=None, gt=0)
    stop_loss: Optional[float] = Field(default=None, gt=0)
    take_profit: Optional[float] = Field(default=None, gt=0)
    slippage_bps: float = Field(default=1, ge=0, le=100)


class PositionLevelsIn(BaseModel):
    stop_loss: Optional[float] = Field(default=None, gt=0)
    take_profit: Optional[float] = Field(default=None, gt=0)


@app.post("/api/paper/positions/{symbol}/levels")
def paper_position_levels(symbol: str, body: PositionLevelsIn):
    """Move a live position's stop-loss / take-profit (used by the draggable chart lines)."""
    symbol = symbol.strip().upper()
    with LOCK:
        state = get_paper_state()
        pos = next((p for p in state.get("positions", []) if p["symbol"] == symbol), None)
        if not pos:
            raise HTTPException(status_code=404, detail=f"No open position for {symbol}")
        long = float(pos["quantity"]) > 0
        px = float(pos["mark_price"])
        if body.stop_loss and ((long and body.stop_loss >= px) or (not long and body.stop_loss <= px)):
            raise HTTPException(status_code=400, detail="That stop would trigger immediately. Use Close instead.")
        if body.take_profit and ((long and body.take_profit <= px) or (not long and body.take_profit >= px)):
            raise HTTPException(status_code=400, detail="That target is already reached. Use Close instead.")
        pos["stop_loss"] = body.stop_loss
        pos["take_profit"] = body.take_profit
        save_paper_state(state)
    log(f"{symbol} levels set: SL {body.stop_loss or '-'} · TP {body.take_profit or '-'}")
    return with_risk_status(state)


@app.get("/api/markets")
def markets():
    return {"markets": market_data.DEFAULTS, "conditions": {m: instruments.SPECS[m] for m in instruments.SPECS}}


@app.get("/api/market/session")
def market_session(symbol: str):
    return instruments.session_info(symbol)


def market_error(exc: Exception, what: str) -> str:
    """Short, human message for a failed market data call (the raw error goes to the log)."""
    try:  # file only: the Activity list shouldn't fill up while offline
        with open(DATA / "logs" / "market-errors.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {what}: {str(exc)[:300]}\n")
    except OSError:
        pass
    if isinstance(exc, urllib.error.HTTPError):
        return f"No market data for {what}" if exc.code in (400, 404) else "The market data provider is busy. Trying again shortly."
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return "Can't load prices. Check your internet connection."
    return f"Market data unavailable for {what}"


@app.get("/api/market/quote")
def market_quote(symbol: str):
    try:
        q = market_data.quote(symbol)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=market_error(exc, symbol))
    bid, ask = instruments.bid_ask(q)
    return {**q, "bid": bid, "ask": ask, "session": instruments.session_info(q["symbol"])}


@app.get("/api/market/quotes")
def market_quotes(symbols: str):
    """Watchlist: last price and daily change for up to 40 comma-separated symbols."""
    wanted = [x.strip() for x in symbols.split(",") if x.strip()]
    out = []
    for q in market_data.quotes(wanted):
        bid, ask = instruments.bid_ask(q)
        out.append({"symbol": q["symbol"], "price": q["price"], "bid": bid, "ask": ask, "change_pct": q["change_pct"], "delayed": q["delayed"], "spark": q.get("spark", [])})
    return out


@app.get("/api/market/candles")
def market_candles(symbol: str, timeframe: str = "1h", limit: int = 300, period: Optional[str] = None):
    try:
        return market_data.candles(symbol, timeframe, limit, period)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=market_error(exc, symbol))


@app.post("/api/paper/order")
def paper_order(body: OrderIn):
    mode = state_get("operation_mode", {"mode": "manual"})
    if mode.get("mode") == "ai_setup":
        raise HTTPException(status_code=403, detail="Orders are disabled in AI Setup mode.")
    if not get_paper_state().get("active"):
        raise HTTPException(status_code=409, detail="Start the engine before placing orders")
    symbol = body.symbol.strip().upper()
    quotes, bars, errors = fetch_market([symbol], get_paper_state())
    if not quotes:
        raise HTTPException(status_code=502, detail=f"No price for {symbol}: {errors[0] if errors else 'unknown error'}")
    q = quotes[0]
    with LOCK:
        state = get_paper_state()
        update_quotes(state, quotes, bars, current_risk())
        try:
            order = submit_order(state, body.model_dump(), q, current_risk())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        record_equity(state)
        save_paper_state(state)
    px = order.get("filled_price")
    log(f"Order {order.get('status')}: {body.side.upper()} {body.quantity:g} {symbol}" + (f" @ {px:g}" if px else ""))
    return {"order": order, "quote": q, "portfolio": with_risk_status(state)}


@app.post("/api/paper/refresh")
def paper_refresh():
    state, quotes, errors = apply_market(open_symbols(get_paper_state()))
    return {"portfolio": with_risk_status(state), "quotes": quotes, "errors": errors}


@app.delete("/api/paper/orders/{order_id}")
def cancel_order(order_id: str):
    with LOCK:
        state = get_paper_state()
        order = next((x for x in state.get("orders", []) if x.get("id") == order_id), None)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if order.get("status") not in ("pending", "triggered"):
            raise HTTPException(status_code=409, detail="Only working orders can be cancelled")
        order["status"] = "cancelled"
        order["cancelled_at"] = time.time()
        save_paper_state(state)
    log(f"Order cancelled: {order['side'].upper()} {order['quantity']:g} {order['symbol']}")
    return order


@app.get("/api/logs")
def get_logs(limit: int = 60):
    limit = max(1, min(limit, 200))
    rows = query("SELECT ts,event FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))
    return [{"timestamp": time.strftime("%H:%M:%S", time.localtime(r["ts"])), "event": r["event"]} for r in reversed(rows)]


class BacktestIn(BaseModel):
    strategy_id: str
    symbol: str = "BTCUSDT"
    timeframe: str = "1h"
    starting_balance: float = Field(default=10000, ge=100, le=10000000)
    parameters: Optional[dict] = None


@app.post("/api/backtest")
def run_backtest(body: BacktestIn):
    """Historical test of any strategy with spreads, fees, risk sizing and intrabar stops."""
    strategy = load_strategy(body.strategy_id)
    eid = engine_id(strategy)
    if not eid:
        raise HTTPException(status_code=501, detail="This strategy has no signal engine")
    try:
        data, bars = closed_candles(body.symbol, body.timeframe, 1000)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Historical data unavailable: {str(exc)[:200]}")
    if len(bars) < 100:
        raise HTTPException(status_code=422, detail="Not enough history for a meaningful test (need 100+ candles)")
    try:
        params = clean_params(strategy.get("parameters", {}), body.parameters or get_strategy_parameters(body.strategy_id)["parameters"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    risk = current_risk()
    res = backtest_engine.run(eid, bars, params, body.symbol.upper(), body.timeframe, body.starting_balance, risk["risk_pct"], base_id=strategy.get("base_id"))
    res.pop("open_position", None)
    res.pop("pending_signal", None)
    return {**res, "strategy": strategy["name"], "symbol": body.symbol.upper(), "timeframe": body.timeframe, "candles": len(bars),
            "from": bars[0]["t"], "to": bars[-1]["t"], "data_source": data.get("source"), "parameters": params,
            "note": "Historical simulation. Past results don't predict future performance."}



class OverviewIn(BaseModel):
    strategy_id: str
    symbol: str = "BTCUSDT"
    timeframe: str = "1h"


@app.post("/api/overview")
def ai_overview(body: OverviewIn):
    """Lesson replay: the strategy's recent trades on this chart, each explained step by step."""
    strategy = load_strategy(body.strategy_id)
    eid = engine_id(strategy)
    if not eid:
        raise HTTPException(status_code=501, detail="This strategy has no signal engine")
    try:
        _, bars = closed_candles(body.symbol, body.timeframe, 1000)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=market_error(exc, body.symbol.upper()))
    if len(bars) < 120:
        raise HTTPException(status_code=422, detail="Not enough history on this chart yet. Try a longer timeframe.")
    params = clean_params(strategy.get("parameters", {}), get_strategy_parameters(body.strategy_id)["parameters"])
    risk = current_risk()
    bt = backtest_engine.run(eid, bars, params, body.symbol.upper(), body.timeframe, 10000, risk["risk_pct"],
                             base_id=strategy.get("base_id"), keep_engine=True)
    return lesson_engine.build(strategy, eid, bars, params, bt, risk["risk_pct"], body.symbol.upper(), body.timeframe)


class ChatIn(BaseModel):
    message: str
    context: dict = Field(default_factory=dict)


@app.post("/api/chat")
def chat(body: ChatIn):
    settings = read_ai_settings()
    if not settings["api_key"]:
        raise HTTPException(status_code=400, detail="Configure your OpenAI-compatible API key in AI Settings")
    context = dict(body.context)
    selected_id = context.get("strategy_id")
    strategy = get_builtin(selected_id) if selected_id else None
    if selected_id and not strategy:
        row = _one("SELECT json FROM custom_strategies WHERE id=?", (selected_id,))
        strategy = json.loads(row["json"]) if row else None
    system = "You are APEX, a careful trading research assistant. Do not provide personalized financial advice or claim demo data is real. Distinguish facts, assumptions and hypotheses. The APEX strategy library specification below is authoritative context; do not invent missing strategy rules. "
    if strategy:
        context["strategy_parameters"] = get_strategy_parameters(selected_id)["parameters"]
        system += "\n\nSELECTED STRATEGY SPECIFICATION:\n" + json.dumps(strategy, ensure_ascii=False)
    context = dict(context or {})
    # Only a summary: the full state holds up to 2000 trades and would blow up the prompt.
    p = get_paper_state()
    context["paper_portfolio"] = {k: p.get(k) for k in ("balance", "equity", "realized_pnl", "floating_pnl", "fees_paid", "positions")}
    context["paper_portfolio"]["recent_trades"] = p.get("trades", [])[-10:]
    system += "\n\nWORKSPACE CONTEXT:\n" + json.dumps(context, ensure_ascii=False)
    payload = {"model": settings["model"], "messages": [{"role": "system", "content": system}, {"role": "user", "content": body.message}], "temperature": 0.35}
    result = provider_request("/chat/completions", method="POST", payload=payload)
    try:
        reply = result["choices"][0]["message"]["content"]
        if isinstance(reply, list):
            reply = "\n".join(part.get("text", "") for part in reply if isinstance(part, dict))
        if not isinstance(reply, str) or not reply.strip():
            raise ValueError("empty response")
    except (KeyError, IndexError, TypeError, ValueError):
        raise HTTPException(status_code=502, detail="AI provider response did not contain a chat completion")
    log("AI chat completed")
    return {"reply": reply}


def watch_parent(pid: int):
    """Exit when the APEX window process is gone, so a crash or force-quit never leaves
    an orphaned backend behind (it would lock the files the next update replaces)."""
    def alive() -> bool:
        if os.name == "nt":
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if not handle:
                return False
            try:
                return kernel32.WaitForSingleObject(handle, 0) == 0x00000102  # WAIT_TIMEOUT: still running
            finally:
                kernel32.CloseHandle(handle)
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def loop():
        while True:
            time.sleep(2)
            if not alive():
                os._exit(0)

    threading.Thread(target=loop, name="apex-parent-watch", daemon=True).start()


if __name__ == "__main__":
    # Windows builds run without a console window, so stdout/stderr are None and
    # uvicorn's logger would crash on start. Send them to the log folder instead.
    if sys.stdout is None or sys.stderr is None:
        stream = open(DATA / "logs" / "backend-console.log", "a", encoding="utf-8")
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    if args.parent_pid:
        watch_parent(args.parent_pid)
    log("backend start")
    print(f"APEX backend listening on 127.0.0.1:{args.port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False)
