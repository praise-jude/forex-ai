import type { AccountKey, ConfidenceTier, Pair, SignalSource } from "./types";

/**
 * A real, in-memory activity trail for autoExecutionListener.ts -- built 2026-09-11 after
 * an operator spent a whole night unable to tell whether the autopilot had EVER actually
 * fired a trade on its own (it had -- proven only by manually querying the database for
 * a millisecond-scale gap between a signal's createdAt and its trade's attemptedAt).
 * That answer should never require a manual DB dig again: this records every signal the
 * listener even LOOKS at (regardless of what happens to it next) and the outcome of every
 * real execution attempt, surfaced on the Autopilot Maintenance panel (web + mobile) via
 * maintenanceCheck.ts's autoExecutionActivity field.
 *
 * Deliberately in-memory only (same "since last restart" posture as evaluationLog.ts's
 * getLastEvaluationAt and connectionWatcher.ts's own state) -- this is live-operations
 * visibility, not an audit ledger; positionStore/tradeJournal already persist the real
 * financial record. Resetting on restart is honest: "since boot" is exactly the window
 * this exists to answer for.
 */

export interface AutoExecutionAttemptRecord {
  signalId: string;
  pair: Pair;
  tier: ConfidenceTier;
  source: SignalSource;
  direction: "long" | "short";
  /** Null for the two gates that stop a signal before an account is even resolved
   * (autopilot locked, engine mode is ANALYSIS) -- there's no real account to name yet. */
  account: AccountKey | null;
  /** Short machine-ish label, not a full sentence -- e.g. "filled", "duplicate",
   * "blocked: kill_switch", "skipped_sizing: ...", "rejected: ...", "error: ...". */
  result: string;
  at: number;
}

interface AutoExecutionActivityState {
  signalsSeen: number;
  lastSignalSeenAt: number | null;
  lastSignalSeen: { pair: Pair; tier: ConfidenceTier; source: SignalSource } | null;
  attemptsTotal: number;
  filledTotal: number;
  /** Ring buffer, most recent first -- capped, see MAX_RECORDS. */
  recentAttempts: AutoExecutionAttemptRecord[];
}

const MAX_RECORDS = 20;

const globalKey = Symbol.for("forex-ai.autoExecutionActivity");
type GlobalWithState = typeof globalThis & { [globalKey]?: AutoExecutionActivityState };
const g = globalThis as GlobalWithState;
const state: AutoExecutionActivityState =
  g[globalKey] ??
  (g[globalKey] = {
    signalsSeen: 0,
    lastSignalSeenAt: null,
    lastSignalSeen: null,
    attemptsTotal: 0,
    filledTotal: 0,
    recentAttempts: [],
  });

/** Called for EVERY signal the auto-execution listener looks at, regardless of which
 * gate (if any) stops it afterward -- the direct answer to "is the listener even
 * receiving signals at all", the first and most basic thing to verify. */
export function recordSignalSeen(pair: Pair, tier: ConfidenceTier, source: SignalSource): void {
  state.signalsSeen++;
  state.lastSignalSeenAt = Date.now();
  state.lastSignalSeen = { pair, tier, source };
}

/** Called for every real execution attempt AND every early gate that stops one before
 * attemptExecution is even called (autopilot lock, analysis mode, engine disabled, risk
 * acknowledgement, adverse open position) -- `result` should name which. */
export function recordAttempt(record: Omit<AutoExecutionAttemptRecord, "at">): void {
  const full: AutoExecutionAttemptRecord = { ...record, at: Date.now() };
  state.attemptsTotal++;
  if (record.result === "filled") state.filledTotal++;
  state.recentAttempts = [full, ...state.recentAttempts].slice(0, MAX_RECORDS);
}

export interface AutoExecutionActivitySnapshot {
  signalsSeen: number;
  lastSignalSeenAt: number | null;
  lastSignalSeen: { pair: Pair; tier: ConfidenceTier; source: SignalSource } | null;
  attemptsTotal: number;
  filledTotal: number;
  recentAttempts: AutoExecutionAttemptRecord[];
}

export function getAutoExecutionActivity(): AutoExecutionActivitySnapshot {
  return { ...state, recentAttempts: [...state.recentAttempts] };
}

/** Test-only. */
export function resetAutoExecutionActivityForTests(): void {
  state.signalsSeen = 0;
  state.lastSignalSeenAt = null;
  state.lastSignalSeen = null;
  state.attemptsTotal = 0;
  state.filledTotal = 0;
  state.recentAttempts = [];
}
