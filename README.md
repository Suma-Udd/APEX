# APEX: paper trading workspace

A desktop app for practising trading strategies with fake money on real market prices. It runs on macOS and Windows.

- **Live prices**: Binance for crypto, Yahoo Finance for forex, gold, stocks and indices
- **Trading chart** with candles, EMA overlays, your positions, and stop loss / take profit lines you can drag
- **TradingView view**, plus a button that opens the symbol on tradingview.com
- **Paper broker** that behaves like a real margin account (details below): bid/ask fills, fees, leverage limits, margin close-out, market hours
- **Orders**: market, limit, stop and stop limit, with stop loss / take profit, close one or close all, account reset
- **Risk limits** that actually get enforced: risk per trade, max drawdown, daily loss limit, max open positions
- **10 working strategies**, each with real signal code, editable parameters, and your own copies
- **Backtester** for every strategy: same costs and fill rules as the paper account, with equity curve, drawdown, profit factor, Sharpe and a trade list
- **Three modes**: Manual, AI Setup (AI tunes the selected strategy and shows where it stands), AI Auto (AI tunes it, then the engine trades its signals for you)
- **AI chat** that knows your selected strategy and account (optional, any OpenAI-compatible API such as FreeLLMAPI)

Nothing here touches a real broker. Every fill is simulated on your own computer.

## How the simulation works

It's built to behave like a European retail CFD / margin broker, so you don't get used to things a real account won't let you do.

| Market | Max leverage (ESMA) | Spread used when the feed has none | Commission |
| --- | --- | --- | --- |
| Crypto | 2:1 | real Binance bid/ask | 0.10% per side |
| Forex | 30:1 | about 1 bp | none (spread only) |
| Gold | 20:1 | about 1.4 bp | none |
| Indices | 20:1 | about 1.2 bp | none |
| Stocks | 5:1 | about 2 bp | 0.02%, $1 minimum |

- **Margin.** Every position ties up `size x price / leverage`. New trades need enough free margin. If equity falls under 50% of used margin, everything gets closed out, like a real broker would.
- **Fills.** Market buys fill at the ask and sells at the bid, plus 1 bp of slippage. Limit orders and take profits fill at your price. Stops fill at the stop, or worse if price gaps past it.
- **Nothing gets skipped.** Every 15 seconds the engine checks the 1-minute candles since the last check, so a spike through your stop between checks still fills.
- **Market hours.** Crypto trades 24/7. Forex and gold run Sunday 17:00 to Friday 17:00 New York time. US stocks and indices run 09:30 to 16:00 New York, the DAX 09:00 to 17:30 Frankfurt. When a market is closed, market orders are refused and working orders wait for the open. Holidays aren't modelled.
- **Strategies** decide on a finished candle and act on the next one. The backtester and AI Auto use the exact same code, so a backtest shows how the bot would really have traded.
- **Not modelled:** overnight financing (swap), partial fills, market impact for large orders, exchange holidays.

## How it's built

| Part | Tech | Folder |
| --- | --- | --- |
| Desktop shell | Tauri 2 (Rust) | `src-tauri/` |
| UI | React + TypeScript + Vite, charts by lightweight-charts | `src/` |
| Backend | Python FastAPI, bundled as a sidecar with PyInstaller | `backend/` |

The Tauri shell starts the Python backend on a random local port with a one-time token, and the UI talks to it over `127.0.0.1`.

Your data (paper account, settings, logs) lives here:

- macOS: `~/Library/Application Support/APEX/`
- Windows: `%APPDATA%\APEX\`

## What you need

- **Node.js 22** (20 and 24 work too): https://nodejs.org
- **Python 3.10 or newer**: https://www.python.org. On Windows, tick *Add python.exe to PATH* in the installer.
- **Rust**: https://rustup.rs
- macOS only: `xcode-select --install`
- Windows only: *Desktop development with C++* from the Visual Studio Build Tools installer (rustup offers to install it). WebView2 already ships with Windows 10 and 11.

> **Moving the folder between Mac and Windows?** Delete `node_modules`, `.venv-backend` and `src-tauri/target` first. They only work on the OS they were made on. Everything gets recreated on the next install or build.

## Build the app

The same commands work in Terminal (macOS) and PowerShell (Windows):

```bash
npm install
npm run build:app
```

That builds the backend, the UI and the desktop app, and drops the result in `release/`:

- macOS: `APEX.app` and a `.dmg`
- Windows: a `-setup.exe` installer and an `.msi`

macOS: if DMG packaging fails with `hdiutil ... Resource busy`, run `npm run build:app -- --no-dmg` to build just the `.app`.

## Releases and updates

Installers are built by GitHub, not on your own computer, so the Mac and Windows versions always come out of the same code.

- **Ship a version:** on GitHub open **Actions > Release > Run workflow**, type the next version (like `0.3.0`) and one or two sentences of what's new, then **Run workflow**. In about 15 minutes there's a release with `APEX-Setup.exe` (Windows) and `APEX-mac-arm64.dmg` (Apple Silicon Mac).
- **Test build:** same button with the version left empty. The installers show up under *Artifacts* on the run and nothing is published.
- **Auto updates:** the app checks GitHub a few seconds after launch and every 6 hours. When there's a new version a card pops up with the notes and an **Update and restart** button. Settings also has **Check for updates**.
- Updates are signed. The private key is the `TAURI_SIGNING_PRIVATE_KEY` repo secret (Settings > Secrets and variables > Actions). Keep a backup of it somewhere safe: if it's lost, installed apps can't take new updates and everyone has to reinstall by hand once.
- Every push and pull request runs **CI**: typecheck, UI build, a backend start test and a Rust compile check.

## Work on it

**Fast loop in the browser** (no Rust needed). Use two terminals:

```bash
npm run dev:backend   # Python backend on port 8765
npm run dev           # UI on http://localhost:1420
```

**Inside the real desktop window:**

```bash
npm run backend       # build the Python sidecar once (again whenever backend/ changes)
npm run tauri dev
```

## AI setup (optional)

Click ⚙ in the top right.

- Base URL: `http://127.0.0.1:31415/v1` for FreeLLMAPI, or any OpenAI-compatible endpoint
- Model: `auto` if your gateway routes automatically, otherwise a model ID
- API key: your key or FreeLLMAPI Superkey

Hit **Save and test**. The key is stored in `config/openai.json` inside the data folder above and is never sent back to the UI.

## Limits worth knowing

- Yahoo prices can be delayed, and the app labels them that way. Binance spot prices are close to real time.
- Yahoo has no 4h candles, so APEX builds them from 1h candles.
- The engine (fills, stops, AI Auto) runs inside the app's backend. The app has to stay open with the engine running. After a restart the engine always starts paused, on purpose.
- Some strategies need interpretation of their spec, e.g. Swing MTF treats 4 chart candles as one higher-timeframe candle, and the scalping spread filter is in basis points.
- The TradingView view is display only. TradingView has no public API for third-party apps to place trades in your TradingView paper account, so the two accounts are separate.
- Backtests and AI suggestions are research, not predictions.
