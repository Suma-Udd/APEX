# Plan: trade notifications (Telegram first, Discord second)

Status: v1 built 2026-11-08 (Telegram own-bot + Discord webhook, catch-up on reopen). Not built yet: share card image, daily summary, shared bot. Written 2026-11-07.

## Goal

Link a Telegram chat (and optionally a Discord channel) to APEX so trades show up there as they happen: fills, closes, stop/target hits, and a louder "big win" message for screenshots and showing off to friends.

## Short answer: is it possible?

Yes, and it's not much work. Everything already flows through one function (`fill_order` in `backend/modules/paper_engine.py`), every fill is appended to `state["trades"]` with symbol, side, price, fee, realized P&L and a reason ("stop loss", "take profit", "manual close", "margin close-out ..."). The Python backend can already make HTTPS calls (it does for Binance/Yahoo/AI with a certifi SSL context that works on Mac and Windows). So sending a Telegram or Discord message is one more outbound HTTPS call from the backend. No Rust changes, no CSP changes, no new Python packages.

The one hard limit: **notifications only fire while APEX is open.** Prices are real, but the paper engine that checks your stop loss, take profit and limit orders against those prices only runs while the app is open (`background_loop` lives in the backend sidecar). Today it also does **not** catch up on what it missed: the engine starts paused after a restart and `/api/paper/start` clears `checked`, so a stop that got hit while the app was closed never fills. Open positions just get marked to the current real price. Two ways to improve that, separate from notifications:

- **Catch-up on reopen** (cheap): on start, replay the 1m candles since the last check (Binance gives ~16h of 1m bars per request, Yahoo up to 7 days) and fill any SL/TP/limit that was crossed. Those fills then go out as one digest message.
- **Always-on engine** (big): run the paper engine on a server so trades fill 24/7 with the PC off. Needs hosting, accounts and sync. Not worth it for now.

## Approach options

### A. Bring your own bot (recommended for v1)

The user makes their own Telegram bot in two minutes with @BotFather, pastes the token into APEX, sends `/start` to the bot (or adds it to a group), and APEX picks up the chat id automatically.

- No server, no hosting, no cost, no maintenance.
- Token never leaves the user's computer except to `api.telegram.org`.
- The user picks the bot's name and profile pic. That's actually a plus for the "surprise friends" idea: it can be called whatever, it doesn't have to say APEX.
- Works for private chats, groups (send to the friends group directly) and channels.
- Downside: a short setup step. We make it painless with an in-app walkthrough and auto-detection of the chat.

### B. One shared official "APEX bot"

One bot everyone uses, linked with a one-tap `t.me/ApexBot?start=<code>` deep link.

- Nicer onboarding (tap a link, done).
- **But the bot token can't ship inside the app.** The repo is public and the binary is easy to unpack, so anyone could pull the token and spam every user or hijack the bot. A shared bot needs a small relay server (e.g. a Cloudflare Worker, free tier is enough) that holds the token. The app sends events to the relay, the relay forwards to Telegram.
- That means: hosting, a domain, abuse protection (per-install secret, rate limits), and someone (Sumayer) keeping it alive. Trade data would also pass through our server, which needs a privacy note.
- Worth it only if APEX gets a lot of non-technical users. Can be added later on top of A without changing the event/message code.

### Discord: webhooks (no bot needed)

Discord is easier than Telegram. In any channel: Edit Channel → Integrations → Webhooks → New Webhook → Copy URL. Paste that URL into APEX. Done. No bot, no OAuth, supports rich embeds with colors.

### Others (later, cheap to add once the system exists)

- **ntfy.sh**: free push notifications to phone, no account, just a topic name.
- **Generic webhook**: POST JSON to any URL (lets people wire it into anything).
- WhatsApp is not realistic (Business API, paid, approval process). Skip.

**Recommendation:** v1 = Telegram bring-your-own-bot + Discord webhook. Decide on a shared bot later based on whether people actually find setup annoying.

## How it hooks into the code

New module `backend/modules/notify.py`, plus a few endpoints in `backend/main.py`.

1. **Detecting events.** After every `save_paper_state`, compare `state["trades"]` with a cursor stored in `app_state` (`notify_cursor` = id of the last trade we already handled). Every new trade becomes an event. This catches every path in one place: manual orders, limit/stop fills, SL/TP hits, margin close-out, close-all, and AI Auto mode, without touching the trading logic. Also look at `orders` for newly `rejected` ones and at `state["margin_call"]`.
2. **Classifying.** From the trade + the position before/after: `opened`, `added`, `reduced`, `closed`, `reversed`. Reason string tells us `stop_loss`, `take_profit`, `limit_fill`, `margin_close_out`, `manual`, `auto` (AI mode). For closes we compute P&L %, return on margin, and hold time (position `opened_at` → now).
3. **Sending without slowing trading.** Events go into an in-memory queue. A separate daemon thread sends them. The trading `LOCK` is never held during a network call, so a slow Telegram never freezes the app.
4. **Batching.** If more than 3 events arrive within ~10 s (close-all, catching up after reopening the app, margin close-out), send one digest message instead.
5. **Rate limits + retries.** Telegram allows about 1 msg/s per chat and 20/min per group; Discord webhooks about 5 per 2 s. On HTTP 429 wait `retry_after` and retry, max 3 tries, then drop and log. Never crash the loop.
6. **First run / reset.** When notifications are first enabled, or the paper account is reset (`/api/paper/reset`), move the cursor to the latest trade so old history never gets sent.

### New endpoints

| Endpoint | What it does |
|---|---|
| `GET /api/notify/settings` | Channels + toggles. Secrets come back only as `token_set: true` / masked, never in full. |
| `POST /api/notify/settings` | Save toggles, token, webhook URL, thresholds. |
| `POST /api/notify/telegram/detect` | Calls `getMe` (validates token, returns bot @name) then `getUpdates` and returns chats that messaged the bot recently, so the user just picks "My chat" or "Friends group". |
| `POST /api/notify/test` | Sends a sample message to a channel and returns ok / the error in plain words. |
| `POST /api/notify/preview` | Returns the rendered text of a sample event for the settings preview. |

## Events and defaults

| Event | Default | Notes |
|---|---|---|
| Position closed (any reason) | On | Symbol, side, entry → exit, P&L $ and %, hold time, reason |
| Stop loss hit | On | Part of "closed" but with its own emoji/wording |
| Take profit hit | On | Same |
| Big win | On | Fires instead of the normal close message when P&L ≥ $ threshold (default $1,000) or ≥ % threshold (default 5% of equity). Louder format, made for screenshots |
| Margin close-out | On, can't fully hide | It's the one thing you really want to know |
| Position opened | Off | Can get spammy with Auto mode |
| Limit/stop order filled | Off | |
| Order rejected | Off | |
| AI Auto mode trades | Follows the toggles above | Tagged "🤖 Auto" so you know it wasn't you |
| Daily summary | Off | Sent at a chosen time if the app is open, or on the first open of the next day: trades, win rate, day P&L, equity |

Per-channel toggles, so e.g. the friends group only gets Big wins while your private chat gets everything.

## Message design

Telegram uses `parse_mode=HTML` (safer to escape than MarkdownV2). Short, scannable on a phone lock screen, numbers first.

**Normal close**

```
✅ BTCUSD closed  +$412.80 (+3.1%)
Long 0.25 @ 67,120 → 68,771
Held 2h 14m · take profit
Equity $104,912
```

**Stop loss**

```
🛑 EURUSD stopped out  −$96.40 (−0.8%)
Short 100,000 @ 1.0842 → 1.0852
Held 41m
```

**Big win**

```
🚀🚀 BIG WIN 🚀🚀
NVDA  +$4,820.00  (+18.4%)
Long 120 @ 912.40 → 952.57 · 3h 02m
Today: +$5,310 · 6 trades · 83% win rate
```

**Digest**

```
📦 4 trades closed
BTCUSD +$212.10 · ETHUSD −$40.20 · SOLUSD +$88.00 · XAUUSD +$15.40
Net +$275.30
```

Discord gets the same content as an embed: green/red side color, title = headline, fields for entry/exit/hold, footer for equity.

**Privacy options** (per channel):

- Show amounts in $ / show only % / show both. "% only" is nice for a group chat.
- Show "paper trading" footer: default on. You can turn it off for the prank, that's your call. Heads up though: if friends ever see the app, the joke is over, and the default should stay honest for everyone else using APEX.
- Hide account equity.

**Later (v2): share card image.** A Binance-style PnL card (symbol, big green %, mini chart, entry/exit) rendered in the webview with a `<canvas>`, sent with Telegram `sendPhoto` / Discord file upload. Way more convincing than text. Renders in the frontend so the backend doesn't need Pillow.

## Settings UI

New "Notifications" section in `SettingsModal.tsx`, same style as the AI provider block.

**Telegram card**

1. Collapsed help: "Open @BotFather → /newbot → pick a name → copy the token." With a button that opens `https://t.me/BotFather`.
2. Token field (password input, shows "Saved" when set).
3. "Connect": validates with `getMe`, shows "Connected as @your_bot", then says "Now send /start to @your_bot, or add it to a group." and polls `/detect` for up to 60 s.
4. Chat picker if several chats were found (private chat, group names).
5. "Send test" button.

**Discord card**

1. Help line: "Channel settings → Integrations → Webhooks → Copy URL".
2. Webhook URL field (password input).
3. "Send test".

**Events** checklist (table above), big-win thresholds ($ and %), privacy toggles, live preview of a sample message.

Status dot next to each channel: connected / last send failed (with the reason, e.g. "Bot was removed from the group").

## Security of tokens

- **Where they live:** `DATA/config/notify.json` with file mode 0600, exactly like the AI key in `config/openai.json` today. Same per-user app data folder on Mac (`~/Library/Application Support/APEX`) and Windows (`%APPDATA%\APEX`).
- **Never sent back to the UI.** Settings GET returns `token_set: true` and the bot @name, not the token. The UI can replace or clear it, never read it.
- **Never logged.** Telegram puts the token in the URL path (`/bot<token>/sendMessage`), so urllib errors can contain it. All error text gets run through a redactor before `log()` or before being returned to the UI. Same for Discord webhook URLs.
- **Validation before saving** (stops typos and SSRF-style misuse):
  - Telegram token must match `^\d{6,12}:[A-Za-z0-9_-]{30,}$`, requests only ever go to `https://api.telegram.org`.
  - Discord URL must be `https://discord.com/api/webhooks/...` or `https://discordapp.com/api/webhooks/...`, nothing else.
- **Only the backend talks to Telegram/Discord**, and the backend is already behind the per-launch `X-APEX-Token` and only reachable through the Rust `api` command, so other programs on the machine can't trigger sends.
- **Telegram inbound is ignored.** We only use `getUpdates` during linking to find the chat id. The bot never executes commands, so a stranger messaging your bot can't do anything. After linking we only accept the saved chat id.
- **What a leaked token means:** someone could post as your bot. Fix = `/revoke` in BotFather and paste the new token. The settings page links to that.
- **Later upgrade:** move both the AI key and these secrets into the OS keychain (macOS Keychain / Windows Credential Manager) via the Rust `keyring` crate, with the backend asking the shell for them. Not needed for v1, and doing it for one secret but not the other would be weird, so it should be its own small change.

## Mac vs Windows

Nothing platform specific. Outbound HTTPS from the PyInstaller backend already works on both (certifi bundle). No firewall prompt since it's outbound only. The Telegram/Discord links in settings open with the existing opener the app uses for external links.

## Testing

- Unit tests in `scripts/test-backend.py`: event classification from trade sequences (open, add, partial close, full close, reverse, SL, TP, margin close-out), message rendering, redaction, URL/token validation, batching, cursor reset on account reset. HTTP is mocked, no real bot needed in CI.
- Manual: a throwaway test bot + a test Discord server. Run close-all with 5 positions and check one digest arrives. Kill the network mid-send and check the app doesn't freeze.

## Effort

| Piece | Size |
|---|---|
| `notify.py`: cursor, classification, queue, sender thread, Telegram + Discord, redaction | ~300 lines |
| Endpoints in `main.py` | ~80 lines |
| Settings UI (Telegram card, Discord card, events, preview) | ~250 lines TSX + CSS |
| Tests | ~150 lines |
| **Total v1** | **one PR, roughly a day of work** |
| v2 share card image | half a day |
| Optional shared bot + relay server | 1 to 2 days + hosting to look after |

## Order of work

1. Wait for the 1.3.2 rebuild branch to merge, since this touches `SettingsModal.tsx` and `main.py` which that work is changing too.
2. Backend module + endpoints + tests (Telegram + Discord).
3. Settings UI.
4. Release in the next version.
5. v2: share card image, daily summary.
6. Only if people ask for easier setup: shared bot with relay.

## Open questions for Sumayer

- Default big-win threshold: $1,000 or a % of the account? (Plan says both, whichever hits first.)
- Should the "paper trading" footer be on by default? Plan says yes, toggle to hide.
- Discord in v1 too, or Telegram only first? It's small, plan says include it.
