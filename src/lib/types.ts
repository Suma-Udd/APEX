export type StrategyParam = { type: string; default: number; min: number; max: number };
export type Strategy = {
  id: string; name: string; category: string; description: string; markets: string[]; timeframes: string[];
  indicators: { name: string; parameters: Record<string, unknown> }[]; entry: string[]; exit: string[];
  risk: { default_risk_pct: number; max_positions: number; stop_loss: string; take_profit: string };
  parameters: Record<string, StrategyParam>;
  limitations: string[]; custom?: boolean; version?: number;
};
export type StrategyResponse = { built_in: Strategy[]; custom: Strategy[] };
export type Health = { backend: string; market_data: string; ai: string; ai_configured: boolean };
export type AISettings = { base_url: string; model: string; api_key_set: boolean };

export type Position = {
  id: string; symbol: string; quantity: number; avg_price: number; mark_price: number;
  unrealized_pnl: number; stop_loss: number | null; take_profit: number | null; opened_at: string;
  bid?: number; ask?: number; margin?: number;
};
export type Order = {
  id: string; symbol: string; side: "buy" | "sell"; type: string; quantity: number; status: string;
  limit_price?: number | null; stop_price?: number | null; filled_price?: number; created_at: string;
  reject_reason?: string;
};
export type Trade = {
  id: string; symbol: string; side: "buy" | "sell"; quantity: number; price: number; fee: number;
  realized_pnl?: number; reason: string; timestamp: string;
};
export type PaperState = {
  active: boolean; balance: number; equity: number; realized_pnl: number; floating_pnl: number; fees_paid?: number;
  positions: Position[]; orders: Order[]; trades: Trade[]; feed: string; mode: string;
  peak_equity?: number; day_start_equity?: number; risk_halt?: string | null;
  catch_up_report?: { id: string; count: number; net: number; since: number; at: number };
  used_margin?: number; free_margin?: number; margin_level?: number | null; equity_history?: [number, number][];
};
export type Session = {
  symbol: string; market: string; open: boolean; next_open: string | null; hours: string;
  leverage: number; margin_pct: number; half_spread_bps: number; taker_bps: number; min_fee: number;
};
export type Quote = {
  symbol: string; market: string; price: number; bid: number; ask: number; change_pct: number;
  source: string; delayed: boolean; timestamp: string; session?: Session;
};
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Risk = { risk_pct: number; max_drawdown_pct: number; max_open_positions: number; daily_loss_limit_pct: number };
export type LogItem = { timestamp: string; event: string };
export type OperationMode = "ai_auto" | "ai_setup" | "manual";
export type AISetup = {
  strategy_id: string; strategy_name: string; parameters: Record<string, number>; reason: string; symbol: string;
  timeframe: string; direction: string; entry: number; stop_loss: number | null; take_profit: number | null; data_source: string; delayed: boolean;
  backtest?: { trades: number; win_rate_pct: number; return_pct: number; max_drawdown_pct: number; profit_factor: number | null };
};
export type BacktestTrade = {
  side: "long" | "short"; entry_time: number; exit_time: number; entry: number; exit: number; quantity: number;
  net_pnl: number; r: number | null; bars: number; reason: string;
};
export type Backtest = {
  error?: string; strategy?: string; symbol?: string; timeframe?: string; candles?: number; trades?: number; wins?: number;
  losses?: number; win_rate_pct?: number; net_pnl?: number; return_pct?: number; ending_balance?: number; note?: string;
  profit_factor?: number | null; max_drawdown_pct?: number; sharpe?: number | null; avg_r?: number | null; exposure_pct?: number;
  fees_paid?: number; avg_win?: number; avg_loss?: number; from?: number; to?: number;
  equity_curve?: [number, number][]; trade_log?: BacktestTrade[];
};
export type MiniQuote = { symbol: string; price: number; bid: number; ask: number; change_pct: number; delayed: boolean; spark?: number[] };
