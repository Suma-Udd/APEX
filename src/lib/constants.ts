export type Instrument = { label: string; name: string; api: string; tv: string; market: string };

export const SYMBOLS: Instrument[] = [
  { label: "EUR/USD", name: "Euro", api: "EURUSD=X", tv: "FX:EURUSD", market: "Forex" },
  { label: "GBP/USD", name: "British pound", api: "GBPUSD=X", tv: "FX:GBPUSD", market: "Forex" },
  { label: "USD/JPY", name: "Japanese yen", api: "USDJPY=X", tv: "FX:USDJPY", market: "Forex" },
  { label: "Gold", name: "Gold futures", api: "GC=F", tv: "COMEX:GC1!", market: "Commodities" },
  { label: "BTC/USDT", name: "Bitcoin", api: "BTCUSDT", tv: "BINANCE:BTCUSDT", market: "Crypto" },
  { label: "ETH/USDT", name: "Ethereum", api: "ETHUSDT", tv: "BINANCE:ETHUSDT", market: "Crypto" },
  { label: "SOL/USDT", name: "Solana", api: "SOLUSDT", tv: "BINANCE:SOLUSDT", market: "Crypto" },
  { label: "Apple", name: "AAPL", api: "AAPL", tv: "NASDAQ:AAPL", market: "Stocks" },
  { label: "Microsoft", name: "MSFT", api: "MSFT", tv: "NASDAQ:MSFT", market: "Stocks" },
  { label: "Nvidia", name: "NVDA", api: "NVDA", tv: "NASDAQ:NVDA", market: "Stocks" },
  { label: "Nasdaq 100", name: "NDX", api: "^NDX", tv: "NASDAQ:NDX", market: "Indices" },
  { label: "S&P 500", name: "SPX", api: "^GSPC", tv: "SP:SPX", market: "Indices" },
  { label: "DAX", name: "Germany 40", api: "^GDAXI", tv: "XETR:DAX", market: "Indices" },
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

export const MARKETS = Array.from(new Set(SYMBOLS.map((s) => s.market)));
