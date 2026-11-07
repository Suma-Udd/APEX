export type Instrument = { label: string; api: string; tv: string; market: string };

export const SYMBOLS: Instrument[] = [
  { label: "EUR/USD", api: "EURUSD=X", tv: "FX:EURUSD", market: "Forex" },
  { label: "GBP/USD", api: "GBPUSD=X", tv: "FX:GBPUSD", market: "Forex" },
  { label: "USD/JPY", api: "USDJPY=X", tv: "FX:USDJPY", market: "Forex" },
  { label: "Gold", api: "GC=F", tv: "COMEX:GC1!", market: "Metals" },
  { label: "BTC/USDT", api: "BTCUSDT", tv: "BINANCE:BTCUSDT", market: "Crypto" },
  { label: "ETH/USDT", api: "ETHUSDT", tv: "BINANCE:ETHUSDT", market: "Crypto" },
  { label: "SOL/USDT", api: "SOLUSDT", tv: "BINANCE:SOLUSDT", market: "Crypto" },
  { label: "Apple", api: "AAPL", tv: "NASDAQ:AAPL", market: "Stocks" },
  { label: "Microsoft", api: "MSFT", tv: "NASDAQ:MSFT", market: "Stocks" },
  { label: "Nvidia", api: "NVDA", tv: "NASDAQ:NVDA", market: "Stocks" },
  { label: "Nasdaq 100", api: "^NDX", tv: "NASDAQ:NDX", market: "Indices" },
  { label: "S&P 500", api: "^GSPC", tv: "SP:SPX", market: "Indices" },
  { label: "DAX", api: "^GDAXI", tv: "XETR:DAX", market: "Indices" },
];

// `api` is what the backend understands, `tv` is TradingView's interval code.
export const FRAMES = [
  { label: "1m", api: "1m", tv: "1" },
  { label: "5m", api: "5m", tv: "5" },
  { label: "15m", api: "15m", tv: "15" },
  { label: "1h", api: "1h", tv: "60" },
  { label: "4h", api: "4h", tv: "240" },
  { label: "1D", api: "1d", tv: "D" },
  { label: "1W", api: "1w", tv: "W" },
];

export const findSymbol = (api: string) => SYMBOLS.find((s) => s.api === api);
export const labelFor = (api: string) => findSymbol(api)?.label ?? api;
