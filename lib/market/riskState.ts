import type { AccountKey } from "./types";

export interface DailyRiskState {
  dayKey: string; // YYYY-MM-DD, UTC
  startOfDayEquity: number;
  tradesOpenedToday: number;
  haltedForToday: boolean;
  /** Losing deals in a row (any symbol/origin), reset by a win. Resets to 0 the moment a
   * cooldown trips too, so a fresh streak has to build up again after the pause. */
  consecutiveLosses: number;
  /** Epoch ms the revenge-trading cooldown lifts, or null when no cooldown is active. */
  cooldownUntil: number | null;
}

function dayKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** One independent daily-risk state per account — a bad demo day never halts live
 * trading (or vice versa), since they're different accounts with different equity. */
class RiskStateStore {
  private states = new Map<AccountKey, DailyRiskState>();

  /** Returns today's state for the account, resetting it (fresh trade count, new equity anchor) if the UTC day rolled over. */
  current(nowMs: number, currentEquity: number, account: AccountKey = "live"): DailyRiskState {
    const dayKey = dayKeyFor(nowMs);
    const existing = this.states.get(account);
    if (!existing || existing.dayKey !== dayKey) {
      const fresh: DailyRiskState = {
        dayKey,
        startOfDayEquity: currentEquity,
        tradesOpenedToday: 0,
        haltedForToday: false,
        consecutiveLosses: 0,
        cooldownUntil: null,
      };
      this.states.set(account, fresh);
      return fresh;
    }
    return existing;
  }

  recordTradeOpened(nowMs: number, currentEquity: number, account: AccountKey = "live"): void {
    this.current(nowMs, currentEquity, account).tradesOpenedToday += 1;
  }

  setHaltedForToday(nowMs: number, currentEquity: number, account: AccountKey = "live"): void {
    this.current(nowMs, currentEquity, account).haltedForToday = true;
  }

  /**
   * Called when a deal closes (see metaApiConnection.ts's onDealAdded) -- tracks the
   * losing streak and, once it reaches `maxConsecutiveLosses`, sets a cooldown that
   * checkRiskLimits blocks new execution against until it lifts. A win (or a breakeven
   * deal, profit === 0) resets the streak without touching any active cooldown already
   * in progress.
   */
  recordTradeClosed(
    nowMs: number,
    currentEquity: number,
    profit: number,
    maxConsecutiveLosses: number,
    cooldownMinutes: number,
    account: AccountKey = "live"
  ): void {
    const state = this.current(nowMs, currentEquity, account);
    if (profit < 0) {
      state.consecutiveLosses += 1;
      if (state.consecutiveLosses >= maxConsecutiveLosses) {
        state.cooldownUntil = nowMs + cooldownMinutes * 60_000;
        state.consecutiveLosses = 0;
      }
    } else if (profit > 0) {
      state.consecutiveLosses = 0;
    }
  }
}

const globalKey = Symbol.for("forex-ai.riskState");
type GlobalWithStore = typeof globalThis & { [globalKey]?: RiskStateStore };
const g = globalThis as GlobalWithStore;

export const riskState: RiskStateStore = g[globalKey] ?? (g[globalKey] = new RiskStateStore());
