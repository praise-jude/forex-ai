import type { AccountKey } from "./types";

export interface DailyRiskState {
  dayKey: string; // YYYY-MM-DD, UTC
  startOfDayEquity: number;
  tradesOpenedToday: number;
  haltedForToday: boolean;
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
      const fresh: DailyRiskState = { dayKey, startOfDayEquity: currentEquity, tradesOpenedToday: 0, haltedForToday: false };
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
}

const globalKey = Symbol.for("forex-ai.riskState");
type GlobalWithStore = typeof globalThis & { [globalKey]?: RiskStateStore };
const g = globalThis as GlobalWithStore;

export const riskState: RiskStateStore = g[globalKey] ?? (g[globalKey] = new RiskStateStore());
