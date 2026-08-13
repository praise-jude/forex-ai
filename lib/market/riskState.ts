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
  /** Epoch ms a halt or cooldown most recently tripped, or null if neither has ever
   * tripped today. Set once, on the trip itself -- NOT cleared when the halt/cooldown's
   * own condition later clears (day rollover, cooldown timer), only by an explicit
   * acknowledge() call. This is what forces a human to actually look at what happened
   * before DEMO/LIVE auto-execution can resume, instead of it silently resuming the
   * moment a timer/day rolls over with nobody having reviewed anything -- manual
   * confirm-mode execution is unaffected by this, since a human already reviews every
   * trade there. See requiresAcknowledgement below and autoExecutionListener.ts. */
  pausedAt: number | null;
  acknowledgedAt: number | null;
}

/** True once a halt/cooldown has tripped and hasn't yet been acknowledged since that
 * trip (a fresh trip after an earlier acknowledgement re-requires one). */
export function requiresAcknowledgement(state: DailyRiskState): boolean {
  return state.pausedAt !== null && (state.acknowledgedAt === null || state.acknowledgedAt < state.pausedAt);
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
        pausedAt: null,
        acknowledgedAt: null,
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
    const state = this.current(nowMs, currentEquity, account);
    state.haltedForToday = true;
    state.pausedAt = nowMs;
  }

  /** Explicit human action -- the only thing that lets DEMO/LIVE auto-execution resume
   * after a halt/cooldown, see requiresAcknowledgement's own doc comment. */
  acknowledge(nowMs: number, currentEquity: number, account: AccountKey = "live"): void {
    this.current(nowMs, currentEquity, account).acknowledgedAt = nowMs;
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
        state.pausedAt = nowMs;
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
