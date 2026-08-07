import type { AccountKey } from "./types";

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

/** These are risk-tolerance numbers, not engineering defaults — tune via env vars per
 * README. `account` "demo" reads the `DEMO_`-prefixed vars, independent of live's —
 * falling back to the same defaults as live (not live's actual configured values) when
 * unset, so demo risk can be tuned without touching live's tuned settings. */
export function loadExecutionConfig(account: AccountKey = "live"): ExecutionConfig {
  const prefix = account === "demo" ? "DEMO_" : "";
  return {
    riskPerTradePct: envNumber(`${prefix}RISK_PER_TRADE_PCT`, 1),
    maxConcurrentPositions: envNumber(`${prefix}MAX_CONCURRENT_POSITIONS`, 3),
    maxDailyLossPct: envNumber(`${prefix}MAX_DAILY_LOSS_PCT`, 5),
    maxTradesPerDay: envNumber(`${prefix}MAX_TRADES_PER_DAY`, 5),
    killSwitchFile:
      account === "demo" ? (process.env.KILL_SWITCH_FILE_DEMO ?? ".trading-paused-demo") : (process.env.KILL_SWITCH_FILE ?? ".trading-paused"),
  };
}
