export interface ExecutionConfig {
  riskPerTradePct: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  maxTradesPerDay: number;
  killSwitchFile: string;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** These are risk-tolerance numbers, not engineering defaults — tune via env vars per README. */
export function loadExecutionConfig(): ExecutionConfig {
  return {
    riskPerTradePct: envNumber("RISK_PER_TRADE_PCT", 1),
    maxConcurrentPositions: envNumber("MAX_CONCURRENT_POSITIONS", 3),
    maxDailyLossPct: envNumber("MAX_DAILY_LOSS_PCT", 5),
    maxTradesPerDay: envNumber("MAX_TRADES_PER_DAY", 5),
    killSwitchFile: process.env.KILL_SWITCH_FILE ?? ".trading-paused",
  };
}
