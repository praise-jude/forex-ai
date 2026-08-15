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

// Realistic mode (see backtestEngine.ts's simulateRealisticOutcome) -- a documented
// starting point to tune, not a claimed-precise figure, same posture as every other
// weighted/tuned constant in this codebase (e.g. setupQualityScore.ts's dimension
// weights). 5% of stop distance is a reasonable approximation of a major pair's typical
// spread relative to a real SMC-derived stop, not the wider tolerance
// executionConfig.ts's own maxSpreadFractionOfStop uses for its block-threshold check.
export const DEFAULT_REALISTIC_SPREAD_FRACTION = 0.05;
