"""Trade notifications to Telegram (your own bot) and Discord (channel webhook).

Everything runs locally. Secrets live in DATA/config/notify.json (0600), are never sent back
to the UI and are scrubbed from every error message. Sending happens on its own thread so a
slow or offline Telegram can never hold up trading.
"""
from __future__ import annotations

import html
import json
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import market_data

TELEGRAM_API = "https://api.telegram.org"
TOKEN_RE = re.compile(r"^\d{6,12}:[A-Za-z0-9_-]{30,64}$")
WEBHOOK_RE = re.compile(r"^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api/webhooks/\d{5,30}/[A-Za-z0-9_-]{20,100}$")

EVENTS = ("close", "stop_loss", "take_profit", "big_win", "margin", "open", "order_fill", "rejected")
DEFAULTS = {
    "telegram": {"enabled": False, "token": "", "chat_id": "", "chat_title": "", "bot_username": "", "big_wins_only": False},
    "discord": {"enabled": False, "webhook": "", "big_wins_only": False},
    "events": {"close": True, "stop_loss": True, "take_profit": True, "big_win": True, "margin": True,
               "open": False, "order_fill": False, "rejected": False},
    "big_win_usd": 1000.0,
    "big_win_pct": 5.0,
    "amounts": "both",          # both | usd | pct
    "show_equity": True,
    "paper_footer": True,
}

BATCH_WINDOW = 3.0   # seconds to wait for more events before sending
DIGEST_AFTER = 3     # more events than this in one batch -> one digest message


def redact(text: str, settings: dict | None = None) -> str:
    """Remove bot tokens and webhook secrets from any string before it's logged or shown."""
    text = str(text)
    text = re.sub(r"bot\d{6,12}:[A-Za-z0-9_-]+", "bot<token>", text)
    text = re.sub(r"\d{6,12}:[A-Za-z0-9_-]{30,64}", "<token>", text)
    text = re.sub(r"(api/webhooks/\d+/)[A-Za-z0-9_-]+", r"\1<secret>", text)
    for secret in ((settings or {}).get("telegram", {}).get("token"), (settings or {}).get("discord", {}).get("webhook")):
        if secret:
            text = text.replace(secret, "<secret>")
    return text


class NotifyError(Exception):
    pass


# ── Settings ───────────────────────────────────────────────────────────────

class Store:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def read(self) -> dict:
        with self._lock:
            raw = {}
            if self.path.exists():
                try:
                    raw = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    raw = {}
        out = json.loads(json.dumps(DEFAULTS))
        for key, val in raw.items():
            if isinstance(out.get(key), dict) and isinstance(val, dict):
                out[key].update({k: v for k, v in val.items() if k in out[key]})
            elif key in out:
                out[key] = val
        return out

    def write(self, settings: dict):
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(settings, handle)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass


def public_view(s: dict) -> dict:
    """Settings as the UI may see them: secrets replaced by flags."""
    tg, dc = s["telegram"], s["discord"]
    return {
        "telegram": {"enabled": tg["enabled"], "token_set": bool(tg["token"]), "chat_id": tg["chat_id"], "chat_title": tg["chat_title"],
                     "bot_username": tg["bot_username"], "big_wins_only": tg["big_wins_only"]},
        "discord": {"enabled": dc["enabled"], "webhook_set": bool(dc["webhook"]), "big_wins_only": dc["big_wins_only"]},
        **{k: s[k] for k in ("events", "big_win_usd", "big_win_pct", "amounts", "show_equity", "paper_footer")},
    }


def apply_update(s: dict, body: dict) -> dict:
    """Merge a settings update from the UI, validating secrets. Raises NotifyError on bad input."""
    s = json.loads(json.dumps(s))
    tg = body.get("telegram") or {}
    if tg.get("clear_token"):
        s["telegram"].update(token="", chat_id="", chat_title="", bot_username="", enabled=False)
    elif tg.get("token"):
        token = str(tg["token"]).strip()
        if not TOKEN_RE.match(token):
            raise NotifyError("That doesn't look like a bot token. It should look like 123456789:AA... from @BotFather.")
        if token != s["telegram"]["token"]:
            s["telegram"].update(token=token, chat_id="", chat_title="", bot_username="")
    if "chat_id" in tg and tg["chat_id"] is not None:
        chat = str(tg["chat_id"]).strip()
        if chat and not re.match(r"^-?\d{1,20}$", chat):
            raise NotifyError("Chat id must be a number")
        s["telegram"]["chat_id"] = chat
        s["telegram"]["chat_title"] = str(tg.get("chat_title") or "")[:120]
    for key in ("enabled", "big_wins_only"):
        if key in tg:
            s["telegram"][key] = bool(tg[key])

    dc = body.get("discord") or {}
    if dc.get("clear_webhook"):
        s["discord"].update(webhook="", enabled=False)
    elif dc.get("webhook"):
        url = str(dc["webhook"]).strip()
        if not WEBHOOK_RE.match(url):
            raise NotifyError("Paste a Discord webhook URL (https://discord.com/api/webhooks/...).")
        s["discord"]["webhook"] = url
    for key in ("enabled", "big_wins_only"):
        if key in dc:
            s["discord"][key] = bool(dc[key])

    for key, val in (body.get("events") or {}).items():
        if key in EVENTS:
            s["events"][key] = bool(val)
    if "big_win_usd" in body:
        s["big_win_usd"] = max(0.0, min(float(body["big_win_usd"]), 1e9))
    if "big_win_pct" in body:
        s["big_win_pct"] = max(0.0, min(float(body["big_win_pct"]), 1000.0))
    if body.get("amounts") in ("both", "usd", "pct"):
        s["amounts"] = body["amounts"]
    for key in ("show_equity", "paper_footer"):
        if key in body:
            s[key] = bool(body[key])
    if s["telegram"]["enabled"] and not (s["telegram"]["token"] and s["telegram"]["chat_id"]):
        s["telegram"]["enabled"] = False
    if s["discord"]["enabled"] and not s["discord"]["webhook"]:
        s["discord"]["enabled"] = False
    return s


# ── HTTP ───────────────────────────────────────────────────────────────────

def _post(url: str, payload: dict, settings: dict, timeout=10, attempts=3):
    body = json.dumps(payload).encode("utf-8")
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", "User-Agent": "APEX-PaperTrader/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=market_data.SSL_CONTEXT) as r:
                raw = r.read().decode("utf-8") or "{}"
                return json.loads(raw) if raw.strip().startswith("{") else {}
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                data = json.loads(exc.read().decode("utf-8"))
                detail = data.get("description") or data.get("message") or ""
                retry = float((data.get("parameters") or {}).get("retry_after") or data.get("retry_after") or 0)
            except Exception:
                retry = 0
            if exc.code == 429 and attempt < attempts - 1:
                time.sleep(min(max(retry, 1.0), 30))
                continue
            raise NotifyError(redact(_explain(exc.code, detail), settings))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < attempts - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise NotifyError(redact(f"Couldn't reach the server ({exc})", settings))
    raise NotifyError("Gave up after several tries")


def _explain(code: int, detail: str) -> str:
    d = detail.lower()
    if code == 401 or "unauthorized" in d:
        return "Telegram rejected the bot token. Check it or make a new one with @BotFather."
    if "chat not found" in d:
        return "Chat not found. Send /start to your bot (or add it to the group) and pick the chat again."
    if "bot was kicked" in d or "bot was blocked" in d or "not a member" in d:
        return "The bot was removed or blocked in that chat. Add it back and try again."
    if code == 404:
        return "Not found. The Discord webhook was probably deleted, paste a new one."
    return f"HTTP {code}: {detail}" if detail else f"HTTP {code}"


def telegram_call(token: str, method: str, payload: dict, settings: dict):
    data = _post(f"{TELEGRAM_API}/bot{token}/{method}", payload, settings, attempts=2 if method != "sendMessage" else 3)
    if not data.get("ok"):
        raise NotifyError(redact(data.get("description") or "Telegram said no", settings))
    return data["result"]


def detect_chats(settings: dict) -> dict:
    """Validate the token and list chats that recently messaged the bot or added it."""
    token = settings["telegram"]["token"]
    if not token:
        raise NotifyError("Paste your bot token first")
    me = telegram_call(token, "getMe", {}, settings)
    updates = telegram_call(token, "getUpdates", {"timeout": 0, "limit": 100, "allowed_updates": ["message", "channel_post", "my_chat_member"]}, settings)
    chats = {}
    for u in updates:
        for key in ("message", "channel_post", "my_chat_member"):
            chat = (u.get(key) or {}).get("chat")
            if chat:
                title = chat.get("title") or " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x) or chat.get("username") or str(chat["id"])
                chats[str(chat["id"])] = {"id": str(chat["id"]), "title": title, "type": chat.get("type", "private")}
    return {"bot_username": me.get("username", ""), "chats": list(chats.values())[::-1]}


# ── Events ─────────────────────────────────────────────────────────────────

def classify(trade: dict, settings: dict) -> str | None:
    """Which event a fill is, or None if nothing should be sent for it."""
    reason = (trade.get("reason") or "").lower()
    action = trade.get("action")
    ev = settings["events"]
    if reason.startswith("margin close-out"):
        return "margin"  # always sent, it's the one thing you really want to know
    if action in ("close", "reduce", "reverse"):
        if is_big_win(trade, settings) and ev.get("big_win"):
            return "big_win"
        kind = "stop_loss" if reason.startswith("stop loss") else "take_profit" if reason.startswith("take profit") else "close"
        return kind if ev.get(kind) else None
    if action in ("open", "add"):
        if "order filled" in reason:
            return "order_fill" if ev.get("order_fill") or ev.get("open") else None
        return "open" if ev.get("open") else None
    return None


def is_big_win(trade: dict, settings: dict) -> bool:
    pnl = float(trade.get("realized_pnl") or 0)
    if pnl <= 0:
        return False
    eq = float(trade.get("equity_before") or 0)
    usd, pct = float(settings.get("big_win_usd") or 0), float(settings.get("big_win_pct") or 0)
    return (usd > 0 and pnl >= usd) or (pct > 0 and eq > 0 and pnl / eq * 100 >= pct)


def trade_stats(trade: dict) -> dict:
    qty, price = float(trade["quantity"]), float(trade["price"])
    entry = trade.get("entry_price")
    before = float(trade.get("position_before") or 0)
    direction = 1 if before > 0 else -1
    closed_qty = min(abs(before), qty) if before else qty
    pct = ((price - float(entry)) / float(entry) * direction * 100) if entry else None
    held = None
    if trade.get("opened_at"):
        try:
            held = max(0, (datetime.fromisoformat(trade["timestamp"]) - datetime.fromisoformat(trade["opened_at"])).total_seconds())
        except (ValueError, TypeError):
            held = None
    return {"pct": pct, "held": held, "closed_qty": closed_qty, "long": before > 0, "entry": entry}


LABELS = {"EURUSD=X": "EUR/USD", "GBPUSD=X": "GBP/USD", "USDJPY=X": "USD/JPY", "GC=F": "Gold", "SI=F": "Silver",
          "^NDX": "Nasdaq 100", "^GSPC": "S&P 500", "^GDAXI": "DAX", "AAPL": "Apple", "MSFT": "Microsoft", "NVDA": "Nvidia"}


def _label(symbol: str) -> str:
    s = symbol.upper()
    if s in LABELS:
        return LABELS[s]
    for quote_ccy in ("USDT", "USDC", "BUSD"):
        if s.endswith(quote_ccy) and len(s) > len(quote_ccy):
            return f"{s[:-len(quote_ccy)]}/{quote_ccy}"
    if s.endswith("=X") and len(s) == 8:
        return f"{s[:3]}/{s[3:6]}"
    return s


def _num(v: float) -> str:
    v = float(v)
    if v == 0:
        return "0"
    a = abs(v)
    if a >= 1 and v == int(v):
        return f"{int(v):,}"
    digits = 2 if a >= 100 else 4 if a >= 1 else 6
    s = f"{v:,.{digits}f}"
    return s.rstrip("0").rstrip(".") if "." in s and a < 100 else s


def _money(v: float, sign=True) -> str:
    v = float(v)
    s = f"${abs(v):,.2f}"
    return (("+" if v >= 0 else "−") + s) if sign else s


def _dur(sec) -> str:
    if sec is None:
        return ""
    sec = int(sec)
    d, h, m = sec // 86400, sec % 86400 // 3600, sec % 3600 // 60
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m:02d}m"
    return f"{max(m, 1)}m" if sec >= 60 else f"{sec}s"


def _pnl_text(trade, stats, settings) -> str:
    usd = _money(trade["realized_pnl"])
    pct = f"{stats['pct']:+.2f}%" if stats["pct"] is not None else ""
    mode = settings.get("amounts", "both")
    if mode == "usd" or not pct:
        return usd if mode != "pct" else pct or usd
    if mode == "pct":
        return pct
    return f"{usd} ({pct})"


TITLES = {"close": ("✅", "closed"), "stop_loss": ("🛑", "stopped out"), "take_profit": ("🎯", "hit target"),
          "margin": ("⚠️", "margin close-out"), "open": ("🟢", "opened"), "order_fill": ("📥", "order filled")}


def render(event: str, trade: dict, settings: dict, equity: float | None = None, day: dict | None = None) -> dict:
    """One event -> {'title', 'lines', 'color', 'text_html'} used by both Telegram and Discord."""
    st = trade_stats(trade)
    label = _label(trade["symbol"])
    usd_ok = settings.get("amounts", "both") != "pct"
    auto = " · 🤖 Auto" if trade.get("auto") else ""
    later = " (while APEX was closed)" if trade.get("catch_up") else ""
    pnl = float(trade.get("realized_pnl") or 0)
    lines = []
    if event in ("open", "order_fill"):
        side = "Long" if trade["side"] == "buy" else "Short"
        title = f"{TITLES[event][0]} {label} {TITLES[event][1]}"
        lines.append(f"{side} {_num(trade['quantity'])} @ {_num(trade['price'])}" + auto)
        color = 0x2E7DF6
    elif event == "big_win":
        title = "🚀🚀 BIG WIN 🚀🚀"
        side = "Long" if st["long"] else "Short"
        lines.append(f"{label}  {_pnl_text(trade, st, settings)}")
        lines.append(f"{side} {_num(st['closed_qty'])} @ {_num(st['entry'] or 0)} → {_num(trade['price'])}" + (f" · {_dur(st['held'])}" if st["held"] is not None else "") + auto)
        if day and day.get("trades"):
            today = f"Today: {_money(day['pnl'])} · " if usd_ok else "Today: "
            lines.append(f"{today}{day['trades']} trade{'s' if day['trades'] != 1 else ''} · {day['win_rate']:.0f}% win rate")
        color = 0x26A69A
    else:
        emoji, verb = TITLES[event]
        if trade.get("action") == "reduce" and event == "close":
            verb = "partly closed"
        title = f"{emoji} {label} {verb}  {_pnl_text(trade, st, settings)}"
        side = "Long" if st["long"] else "Short"
        lines.append(f"{side} {_num(st['closed_qty'])} @ {_num(st['entry'] or 0)} → {_num(trade['price'])}")
        bits = []
        if st["held"] is not None:
            bits.append(f"Held {_dur(st['held'])}")
        if event == "close":
            reason = trade.get("reason", "").replace(" while APEX was closed", "")
            if reason and reason not in ("market order",):
                bits.append(reason)
        if bits or auto:
            lines.append(" · ".join(bits) + auto)
        color = 0x26A69A if pnl >= 0 else 0xEF5350
    if later:
        lines.append("Filled" + later)
    if settings.get("show_equity", True) and equity is not None and usd_ok and event != "big_win":
        lines.append(f"Equity {_money(equity, sign=False)}")
    footer = "APEX · paper trading" if settings.get("paper_footer", True) else ""
    text_html = f"<b>{html.escape(title)}</b>\n" + "\n".join(html.escape(l) for l in lines) + (f"\n<i>{html.escape(footer)}</i>" if footer else "")
    return {"title": title, "lines": lines, "color": color, "footer": footer, "text_html": text_html}


def render_digest(items: list, settings: dict) -> dict:
    closes = [t for e, t in items if t.get("action") in ("close", "reduce", "reverse")]
    n = len(items)
    usd_ok = settings.get("amounts", "both") != "pct"
    title = f"📦 {n} trade{'s' if n != 1 else ''}" + (" closed" if len(closes) == n else "")
    parts = []
    for e, t in items[:12]:
        if t.get("action") in ("close", "reduce", "reverse"):
            st = trade_stats(t)
            amt = _money(t["realized_pnl"]) if usd_ok else (f"{st['pct']:+.2f}%" if st["pct"] is not None else "")
            parts.append(f"{_label(t['symbol'])} {amt}")
        else:
            parts.append(f"{_label(t['symbol'])} {'buy' if t['side'] == 'buy' else 'sell'}")
    lines = [" · ".join(parts) + (" …" if n > 12 else "")]
    net = sum(float(t["realized_pnl"]) for t in closes)
    if closes and usd_ok:
        lines.append(f"Net {_money(net)}")
    if any(t.get("catch_up") for _, t in items):
        lines.append("Filled while APEX was closed")
    footer = "APEX · paper trading" if settings.get("paper_footer", True) else ""
    text_html = f"<b>{html.escape(title)}</b>\n" + "\n".join(html.escape(l) for l in lines) + (f"\n<i>{html.escape(footer)}</i>" if footer else "")
    return {"title": title, "lines": lines, "color": 0x26A69A if net >= 0 else 0xEF5350, "footer": footer, "text_html": text_html}


def send_message(msg: dict, settings: dict, channel: str):
    if channel == "telegram":
        tg = settings["telegram"]
        telegram_call(tg["token"], "sendMessage", {"chat_id": tg["chat_id"], "text": msg["text_html"], "parse_mode": "HTML",
                                                   "disable_web_page_preview": True}, settings)
    else:
        embed = {"title": msg["title"][:256], "description": "\n".join(msg["lines"])[:4000], "color": msg["color"]}
        if msg["footer"]:
            embed["footer"] = {"text": msg["footer"]}
        _post(settings["discord"]["webhook"] + "?wait=true", {"embeds": [embed], "allowed_mentions": {"parse": []}}, settings)


def channels_for(settings: dict, big: bool) -> list:
    out = []
    tg, dc = settings["telegram"], settings["discord"]
    if tg["enabled"] and tg["token"] and tg["chat_id"] and (big or not tg["big_wins_only"]):
        out.append("telegram")
    if dc["enabled"] and dc["webhook"] and (big or not dc["big_wins_only"]):
        out.append("discord")
    return out


SAMPLE = {"id": "sample", "symbol": "BTCUSDT", "side": "sell", "quantity": 0.25, "price": 68771.0, "fee": 17.19,
          "realized_pnl": 412.75, "reason": "take profit", "action": "close", "entry_price": 67120.0,
          "position_before": 0.25, "position_after": 0.0, "equity_before": 104500.0,
          "opened_at": "2026-11-08T10:00:00+00:00", "timestamp": "2026-11-08T12:14:00+00:00"}


# ── The notifier ───────────────────────────────────────────────────────────

class Notifier:
    """Watches the paper account for new trades and sends them out on a background thread."""

    def __init__(self, store: Store, cursor_get, cursor_put, log):
        self.store, self._cursor_get, self._cursor_put, self._log = store, cursor_get, cursor_put, log
        self._q: queue.Queue = queue.Queue()
        self._seen_lock = threading.Lock()
        self._status = {"telegram": {"ok": None, "error": "", "at": None}, "discord": {"ok": None, "error": "", "at": None}}
        self._thread = None

    def start(self):
        if not self._thread:
            self._thread = threading.Thread(target=self._run, name="apex-notify", daemon=True)
            self._thread.start()

    def status(self):
        return json.loads(json.dumps(self._status))

    def reset_cursor(self, state):
        trades = state.get("trades") or []
        self._cursor_put({"last": trades[-1]["id"] if trades else None, "count": len(trades)})

    def observe(self, state):
        """Called after every save of the paper account. Cheap when nothing changed."""
        trades = state.get("trades") or []
        with self._seen_lock:
            cur = self._cursor_get()
            if cur is None:
                self.reset_cursor(state)  # first run: never send old history
                return
            last = cur.get("last")
            if trades and trades[-1]["id"] == last:
                return
            ids = [t["id"] for t in trades]
            # If the last one we saw is gone (account reset, history trimmed) just resync quietly.
            new = trades if last is None else trades[ids.index(last) + 1:] if last in ids else []
            self._cursor_put({"last": ids[-1] if ids else None, "count": len(trades)})
        if not new:
            return
        settings = self.store.read()
        if not channels_for(settings, big=True):
            return
        for t in new:
            event = classify(t, settings)
            if event:
                self._q.put((event, t, float(state.get("equity") or 0), _day_stats(trades)))

    def _run(self):
        while True:
            first = self._q.get()
            batch = [first]
            deadline = time.time() + BATCH_WINDOW
            while time.time() < deadline:
                try:
                    batch.append(self._q.get(timeout=max(0.05, deadline - time.time())))
                except queue.Empty:
                    break
            try:
                self._deliver(batch)
            except Exception as exc:  # never let the sender die
                self._log(f"Notification error: {redact(exc, self.store.read())[:200]}")

    def _deliver(self, batch):
        settings = self.store.read()
        bigs = [b for b in batch if b[0] in ("big_win", "margin")]
        rest = [b for b in batch if b[0] not in ("big_win", "margin")]
        messages = []  # (msg, is_big)
        for event, trade, equity, day in bigs:
            messages.append((render(event, trade, settings, equity, day), event == "big_win"))
        if len(rest) > DIGEST_AFTER:
            messages.append((render_digest([(e, t) for e, t, _, _ in rest], settings), False))
        else:
            for event, trade, equity, day in rest:
                messages.append((render(event, trade, settings, equity, day), False))
        for msg, big in messages:
            for channel in channels_for(settings, big):
                self.send(msg, settings, channel)
                time.sleep(1.0)  # stay under Telegram's ~1 message/second per chat

    def send(self, msg, settings, channel):
        try:
            send_message(msg, settings, channel)
            self._status[channel] = {"ok": True, "error": "", "at": time.time()}
            return True
        except NotifyError as exc:
            self._status[channel] = {"ok": False, "error": str(exc), "at": time.time()}
            self._log(f"{channel.capitalize()} notification failed: {exc}")
            return False


def _day_stats(trades):
    today = datetime.now(timezone.utc).date().isoformat()
    closes = [t for t in trades if (t.get("timestamp") or "").startswith(today) and t.get("realized_pnl")]
    wins = sum(1 for t in closes if float(t["realized_pnl"]) > 0)
    return {"trades": len(closes), "pnl": sum(float(t["realized_pnl"]) for t in closes),
            "win_rate": (wins / len(closes) * 100) if closes else 0.0}
