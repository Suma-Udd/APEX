"""Built-in APEX strategy specifications. Definitions are deterministic and AI-independent."""
from copy import deepcopy

BUILTIN_STRATEGIES = [
    {
        "id": "trend-following-ema", "name": "Trend Following · EMA Cross", "category": "Trend",
        "description": "Follows directional moves after a fast EMA crosses a slow EMA, with an optional trend-strength filter.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["15m", "1h", "4h", "1d"],
        "indicators": [{"name": "EMA", "parameters": {"fast": 20, "slow": 50}}, {"name": "ADX", "parameters": {"period": 14, "minimum": 20}}],
        "entry": ["Long when EMA(20) crosses above EMA(50) and ADX(14) is at least 20.", "Short when EMA(20) crosses below EMA(50) and ADX(14) is at least 20."],
        "exit": ["Exit on opposite EMA cross or configured stop-loss/take-profit."],
        "risk": {"default_risk_pct": 0.5, "max_positions": 2, "stop_loss": "ATR(14) × 2", "take_profit": "2R"},
        "parameters": {"fast_ema": {"type": "integer", "default": 20, "min": 2, "max": 100}, "slow_ema": {"type": "integer", "default": 50, "min": 5, "max": 300}, "adx_min": {"type": "number", "default": 20, "min": 0, "max": 60}},
        "limitations": ["EMA crosses lag price and can whipsaw in sideways markets.", "ADX is a strength filter, not a directional signal."],
    },
    {
        "id": "mean-reversion-bb-rsi", "name": "Mean Reversion · Bollinger + RSI", "category": "Mean Reversion",
        "description": "Looks for price extremes relative to Bollinger Bands with RSI confirmation in range-bound conditions.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["15m", "1h", "4h"],
        "indicators": [{"name": "Bollinger Bands", "parameters": {"period": 20, "deviations": 2}}, {"name": "RSI", "parameters": {"period": 14}}],
        "entry": ["Long when close is below the lower band and RSI(14) is below 30.", "Short when close is above the upper band and RSI(14) is above 70."],
        "exit": ["Target the middle Bollinger Band; exit early if volatility expands sharply."],
        "risk": {"default_risk_pct": 0.35, "max_positions": 1, "stop_loss": "1.5 × ATR(14) beyond entry", "take_profit": "Bollinger middle band"},
        "parameters": {"bb_period": {"type": "integer", "default": 20, "min": 5, "max": 100}, "bb_deviations": {"type": "number", "default": 2, "min": 1, "max": 3.5}, "rsi_period": {"type": "integer", "default": 14, "min": 2, "max": 50}, "oversold": {"type": "integer", "default": 30, "min": 5, "max": 45}, "overbought": {"type": "integer", "default": 70, "min": 55, "max": 95}},
        "limitations": ["Can continue losing during strong trends.", "Requires a regime filter and strict stops."],
    },
    {
        "id": "breakout-volatility", "name": "Breakout · Range Expansion", "category": "Breakout",
        "description": "Trades confirmed breaks of a recent range when volatility expands and volume confirms the move.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["5m", "15m", "1h", "4h"],
        "indicators": [{"name": "Donchian Channel", "parameters": {"period": 20}}, {"name": "ATR", "parameters": {"period": 14}}],
        "entry": ["Enter long after a candle closes above the prior 20-bar high with an expansion filter.", "Enter short after a candle closes below the prior 20-bar low with an expansion filter."],
        "exit": ["Use an ATR trailing stop or fixed 2R target."],
        "risk": {"default_risk_pct": 0.4, "max_positions": 1, "stop_loss": "1.5 × ATR(14)", "take_profit": "2R or trailing ATR"},
        "parameters": {"range_period": {"type": "integer", "default": 20, "min": 5, "max": 100}, "atr_multiplier": {"type": "number", "default": 1.5, "min": 0.5, "max": 4}},
        "limitations": ["False breakouts are common around low-liquidity periods.", "Requires close-confirmation, not intrabar touches."],
    },
    {
        "id": "momentum-rsi-macd", "name": "Momentum · RSI + MACD", "category": "Momentum",
        "description": "Combines RSI momentum and MACD direction to filter weak or conflicting signals.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["15m", "1h", "4h", "1d"],
        "indicators": [{"name": "RSI", "parameters": {"period": 14}}, {"name": "MACD", "parameters": {"fast": 12, "slow": 26, "signal": 9}}],
        "entry": ["Long when RSI rises above 50 and MACD line is above signal.", "Short when RSI falls below 50 and MACD line is below signal."],
        "exit": ["Exit on momentum reversal or configured risk levels."],
        "risk": {"default_risk_pct": 0.4, "max_positions": 2, "stop_loss": "1.5 × ATR(14)", "take_profit": "2R"},
        "parameters": {"rsi_period": {"type": "integer", "default": 14, "min": 2, "max": 50}, "macd_fast": {"type": "integer", "default": 12, "min": 2, "max": 30}, "macd_slow": {"type": "integer", "default": 26, "min": 5, "max": 60}},
        "limitations": ["Momentum can remain overbought or oversold for extended periods."],
    },
    {
        "id": "scalping-ema-vwap", "name": "Scalping · EMA + VWAP", "category": "Scalping",
        "description": "A short-timeframe framework that looks for pullbacks to VWAP/EMA with tight predefined risk.",
        "markets": ["Forex", "Crypto", "Indices"], "timeframes": ["1m", "5m", "15m"],
        "indicators": [{"name": "EMA", "parameters": {"period": 9}}, {"name": "VWAP", "parameters": {"session": "regular"}}],
        "entry": ["Trade pullbacks toward VWAP when price is aligned with EMA(9) and spread/liquidity filters pass."],
        "exit": ["Use a tight volatility-adjusted stop and modest target; flatten before illiquid sessions."],
        "risk": {"default_risk_pct": 0.2, "max_positions": 1, "stop_loss": "0.8 × ATR(14)", "take_profit": "1.2R"},
        "parameters": {"ema_period": {"type": "integer", "default": 9, "min": 3, "max": 30}, "max_spread_points": {"type": "number", "default": 1.5, "min": 0.1, "max": 10}},
        "limitations": ["Sensitive to spread, latency, fees and execution quality.", "Requires reliable intraday market data."],
    },
    {
        "id": "swing-mtf", "name": "Swing · Multi-Timeframe Trend", "category": "Swing",
        "description": "Uses a higher-timeframe trend filter and lower-timeframe pullback confirmation for multi-session setups.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["1h", "4h", "1d"],
        "indicators": [{"name": "EMA", "parameters": {"higher_timeframe": 200, "entry_timeframe": 20}}, {"name": "RSI", "parameters": {"period": 14}}],
        "entry": ["Only take entries aligned with the higher-timeframe EMA(200).", "Enter on a lower-timeframe pullback that regains EMA(20)."],
        "exit": ["Use swing-structure invalidation or 2R–3R target."],
        "risk": {"default_risk_pct": 0.5, "max_positions": 3, "stop_loss": "Beyond recent swing plus buffer", "take_profit": "2R–3R"},
        "parameters": {"trend_ema": {"type": "integer", "default": 200, "min": 50, "max": 300}, "pullback_ema": {"type": "integer", "default": 20, "min": 5, "max": 100}},
        "limitations": ["Requires synchronized higher- and lower-timeframe candles."],
    },
    {
        "id": "grid-bounded", "name": "Grid · Bounded Exposure", "category": "Grid",
        "description": "Places hypothetical staggered levels inside a defined range with strict total exposure caps.",
        "markets": ["Forex", "Crypto"], "timeframes": ["15m", "1h", "4h"],
        "indicators": [{"name": "Range", "parameters": {"lookback": 50}}],
        "entry": ["Define an explicit upper/lower range and evenly spaced levels; do not add levels outside the range."],
        "exit": ["Reduce inventory toward the range midpoint; stop the grid if range invalidates."],
        "risk": {"default_risk_pct": 0.15, "max_positions": 5, "stop_loss": "Range invalidation", "take_profit": "Adjacent grid level"},
        "parameters": {"levels": {"type": "integer", "default": 5, "min": 2, "max": 12}, "range_lookback": {"type": "integer", "default": 50, "min": 10, "max": 200}, "max_exposure_pct": {"type": "number", "default": 5, "min": 0.5, "max": 20}},
        "limitations": ["Grid strategies can accumulate directional inventory in a breakout.", "Never run without an explicit maximum exposure and invalidation rule."],
    },
    {
        "id": "vwap-reversion", "name": "VWAP · Deviation Reversion", "category": "VWAP",
        "description": "Studies deviations from session VWAP and waits for price to re-enter a defined deviation band.",
        "markets": ["Forex", "Crypto", "Indices"], "timeframes": ["5m", "15m", "1h"],
        "indicators": [{"name": "VWAP", "parameters": {"session": "daily"}}, {"name": "Standard Deviation", "parameters": {"bands": 2}}],
        "entry": ["Consider a mean-reversion signal after a close back inside the outer deviation band."],
        "exit": ["Target VWAP or exit if the deviation expands again."],
        "risk": {"default_risk_pct": 0.3, "max_positions": 1, "stop_loss": "Beyond outer deviation band", "take_profit": "VWAP"},
        "parameters": {"deviation": {"type": "number", "default": 2, "min": 1, "max": 3}},
        "limitations": ["VWAP is session-dependent and can be less meaningful in 24/7 markets without a chosen session convention."],
    },
    {
        "id": "macd-crossover", "name": "MACD · Signal Crossover", "category": "Momentum",
        "description": "Uses MACD line/signal crossovers and histogram direction as a momentum-change framework.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["15m", "1h", "4h", "1d"],
        "indicators": [{"name": "MACD", "parameters": {"fast": 12, "slow": 26, "signal": 9}}],
        "entry": ["Long when MACD crosses above signal and histogram turns positive.", "Short when MACD crosses below signal and histogram turns negative."],
        "exit": ["Exit on opposite cross or risk boundary."],
        "risk": {"default_risk_pct": 0.35, "max_positions": 2, "stop_loss": "1.5 × ATR(14)", "take_profit": "2R"},
        "parameters": {"fast": {"type": "integer", "default": 12, "min": 2, "max": 30}, "slow": {"type": "integer", "default": 26, "min": 5, "max": 60}, "signal": {"type": "integer", "default": 9, "min": 2, "max": 20}},
        "limitations": ["MACD is lagging and may produce repeated signals in ranges."],
    },
    {
        "id": "multi-indicator-confluence", "name": "Multi-Indicator Confluence", "category": "Confluence",
        "description": "Requires agreement across trend, momentum and volatility filters before producing a research signal.",
        "markets": ["Forex", "Crypto", "Metals", "Indices"], "timeframes": ["15m", "1h", "4h", "1d"],
        "indicators": [{"name": "EMA", "parameters": {"fast": 20, "slow": 50}}, {"name": "RSI", "parameters": {"period": 14}}, {"name": "ATR", "parameters": {"period": 14}}],
        "entry": ["Require at least three aligned conditions from trend, momentum and volatility filters."],
        "exit": ["Exit when confluence falls below threshold or stop/target is reached."],
        "risk": {"default_risk_pct": 0.3, "max_positions": 2, "stop_loss": "1.5 × ATR(14)", "take_profit": "2R"},
        "parameters": {"minimum_confirmations": {"type": "integer", "default": 3, "min": 2, "max": 5}},
        "limitations": ["Correlated indicators can create an illusion of independent confirmation."],
    },
]


def all_builtin():
    return deepcopy(BUILTIN_STRATEGIES)


def get_builtin(strategy_id: str):
    for item in BUILTIN_STRATEGIES:
        if item["id"] == strategy_id:
            return deepcopy(item)
    return None
