export interface DailyRiskState {
  dayKey: string; // YYYY-MM-DD, UTC
  startOfDayEquity: number;
  tradesOpenedToday: number;
  haltedForToday: boolean;
}

function dayKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

class RiskStateStore {
  private state: DailyRiskState | null = null;

  /** Returns today's state, resetting it (fresh trade count, new equity anchor) if the UTC day rolled over. */
  current(nowMs: number, currentEquity: number): DailyRiskState {
    const dayKey = dayKeyFor(nowMs);
    if (!this.state || this.state.dayKey !== dayKey) {
      this.state = { dayKey, startOfDayEquity: currentEquity, tradesOpenedToday: 0, haltedForToday: false };
    }
    return this.state;
  }

  recordTradeOpened(nowMs: number, currentEquity: number): void {
    this.current(nowMs, currentEquity).tradesOpenedToday += 1;
  }

  setHaltedForToday(nowMs: number, currentEquity: number): void {
    this.current(nowMs, currentEquity).haltedForToday = true;
  }
}

const globalKey = Symbol.for("forex-ai.riskState");
type GlobalWithStore = typeof globalThis & { [globalKey]?: RiskStateStore };
const g = globalThis as GlobalWithStore;

export const riskState: RiskStateStore = g[globalKey] ?? (g[globalKey] = new RiskStateStore());
