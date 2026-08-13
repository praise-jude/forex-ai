import type { Timeframe } from "../types";

// No server-only imports (fs, MetaApi SDK) in this file on purpose -- both
// backtestRunner.ts (server) and BacktestPanel.tsx (client component) need these same
// values, and a client component can't import anything that pulls in node:fs or
// metaapi.cloud-sdk/node.

// Only these three timeframes are ever actually evaluated by the live signal engine
// (mirrors metaApiConnection.ts's own private SIGNAL_TIMEFRAMES) -- backtesting
// anything else would test a combination the live engine never runs.
export const BACKTEST_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];

export const MAX_LOOKBACK_DAYS = 180;
export const DEFAULT_LOOKBACK_DAYS = 60;
