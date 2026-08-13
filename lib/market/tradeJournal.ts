import fs from "node:fs";
import type { AccountKey, MarketRegime, Pair, Session, Signal, Timeframe } from "./types";
import type { SetupQualityBreakdown } from "./setupQualityScore";
import { pipSize } from "./symbols";
import { pipValuePerLot } from "./pipValue";

// Must survive a restart to be useful over time -- same reasoning, and same plain-JSON-
// file-on-disk pattern, as deviceStore.ts (this app has no database; see its own
// comment). Unlike deviceStore, writes here happen on every fired signal and every
// trade close, not just user actions -- still infrequent (a handful a day at most,
// given SMC's own selectivity), so the extra disk I/O is not a real concern.
const STORE_FILE = process.env.TRADE_JOURNAL_FILE ?? ".trade-journal.json";
// A trade can stay open far longer than signalStore's own 4-hour prune window
// (STALE_AFTER_MS) -- that's exactly why the decision-context snapshot below can't
// just reuse signalStore. 30 days comfortably covers any realistic hold time for this
// app's SMC-style setups.
const CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The decision context at the moment a signal fired -- snapshotted separately from
 * the live `Signal` object (which is pruned after 4 hours) so it survives until the
 * trade it may lead to actually closes, however long that takes. */
export interface SignalContext {
  signalId: string;
  pair: Pair;
  timeframe: Timeframe;
  direction: "long" | "short";
  regime: MarketRegime;
  setupQuality: SetupQualityBreakdown;
  confidence: number;
  signerBDirection: Signal["signerBDirection"];
  signerBConfidence: number;
  adx: number;
  rsi: number;
  newsStatus: Signal["newsStatus"];
  session: Session;
  createdAt: number;
}

// "invalidation" -- positionManager.ts's own early exit (the original SMC+Signer B
// thesis got contradicted by a fresh opposite-direction signal) -- is only ever set via
// invalidationMarker.ts's short-lived marker, checked in metaApiConnection.ts's
// journalCloseReasonFor before it falls back to the broker's own deal.reason mapping.
export type JournalCloseReason = "stop_loss" | "take_profit" | "invalidation" | "manual" | "other";

export interface JournalEntry {
  id: string; // the closing deal's own id
  signalId: string;
  account: AccountKey;
  pair: Pair;
  /** Sourced from the joined signal context (see SignalContext) -- ExecutedTrade
   * itself carries no timeframe field, so this is undefined whenever no context was
   * found (aged out or predates this feature), never guessed. */
  timeframe: Timeframe | undefined;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  profit: number;
  /** Null when it genuinely couldn't be computed (e.g. no live price available yet for
   * a USD-base pair's conversion, see pipValuePerLot) -- never a fabricated fallback. */
  riskDollars: number | null;
  rMultiple: number | null;
  reason: JournalCloseReason;
  closedAt: number;
  /** Null when the original signal's context was never captured (predates this
   * feature) or aged out past CONTEXT_RETENTION_MS -- never fabricated. */
  context: SignalContext | null;
}

/** What happened to a proposal from the human/system decision's own point of view --
 * deliberately separate from JournalEntry (a real closed trade's outcome). "approved"
 * is recorded the moment the confirmation-phrase gate passes, before attemptExecution
 * even runs, so it reflects "a human said yes", not "the broker filled it" -- that
 * distinction is what lets getSignalFunnelStats answer "AI signal performance" (was
 * the signal-to-decision pipeline healthy) separately from "actual executed trade
 * performance" (getPerformanceStats, over real fills only). */
export type SignalOutcomeType = "approved" | "rejected" | "expired" | "blocked";

export interface SignalOutcome {
  signalId: string;
  pair: Pair;
  outcome: SignalOutcomeType;
  reason: string | null;
  timestamp: number;
}

interface OnDisk {
  pendingContexts: SignalContext[];
  entries: JournalEntry[];
  signalOutcomes: SignalOutcome[];
}

function readFromDisk(): OnDisk {
  try {
    // turbopackIgnore: STORE_FILE is an operator-configured path, same as
    // deviceStore.ts's own DEVICE_STORE_FILE -- not something to bundle around.
    const raw = fs.readFileSync(/* turbopackIgnore: true */ STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OnDisk>;
    return { pendingContexts: parsed.pendingContexts ?? [], entries: parsed.entries ?? [], signalOutcomes: parsed.signalOutcomes ?? [] };
  } catch {
    // Missing file (first boot) or corrupt content -- start empty rather than crash the
    // whole server over a runtime-state file, same philosophy as deviceStore.ts.
    return { pendingContexts: [], entries: [], signalOutcomes: [] };
  }
}

class TradeJournalStore {
  private state: OnDisk | null = null;

  private load(): OnDisk {
    if (!this.state) this.state = readFromDisk();
    return this.state;
  }

  private persist(): void {
    fs.writeFileSync(STORE_FILE, JSON.stringify(this.load(), null, 2));
  }

  /** Called once per fired signal (see metaApiConnection.ts, right alongside
   * publishSignal) -- never called from anywhere execution/risk-relevant, purely a
   * recording step. */
  recordSignalContext(context: SignalContext): void {
    const state = this.load();
    state.pendingContexts = state.pendingContexts.filter((c) => c.signalId !== context.signalId);
    state.pendingContexts.push(context);
    this.pruneContexts();
    this.persist();
  }

  private pruneContexts(): void {
    const state = this.load();
    const cutoff = Date.now() - CONTEXT_RETENTION_MS;
    state.pendingContexts = state.pendingContexts.filter((c) => c.createdAt >= cutoff);
  }

  /**
   * Called from MarketSyncListener.onDealAdded's existing position-close detection
   * (see metaApiConnection.ts) -- a sibling recording action alongside the push-
   * notification/risk-state logic already there, not a change to it. `contractSize`
   * is supplied by the caller (via getSymbolSpecification, which only
   * metaApiConnection.ts has direct access to) rather than this module reaching back
   * into metaApiConnection.ts itself, to avoid a circular import.
   */
  recordOutcome(input: {
    dealId: string;
    signalId: string;
    account: AccountKey;
    pair: Pair;
    direction: "long" | "short";
    entryPrice: number;
    stopLoss: number;
    lots: number;
    contractSize: number | undefined;
    exitPrice: number;
    profit: number;
    reason: JournalCloseReason;
    closedAt: number;
  }): JournalEntry {
    const state = this.load();

    let riskDollars: number | null = null;
    if (input.contractSize !== undefined) {
      const pips = Math.abs(input.entryPrice - input.stopLoss) / pipSize(input.pair);
      const pipValue = pipValuePerLot(input.pair, input.contractSize);
      // Rounded for the same reason positionSizing.ts's own roundDownToStep rounds
      // before comparing -- raw floating point leaves noise like 100.00000000000009
      // baked permanently into a persisted record otherwise.
      if (pipValue !== undefined && pips > 0) riskDollars = Number((pips * pipValue * input.lots).toFixed(2));
    }
    const rMultiple = riskDollars !== null && riskDollars > 0 ? Number((input.profit / riskDollars).toFixed(4)) : null;

    const context = state.pendingContexts.find((c) => c.signalId === input.signalId) ?? null;
    state.pendingContexts = state.pendingContexts.filter((c) => c.signalId !== input.signalId);

    const entry: JournalEntry = {
      id: input.dealId,
      signalId: input.signalId,
      account: input.account,
      pair: input.pair,
      timeframe: context?.timeframe,
      direction: input.direction,
      entryPrice: input.entryPrice,
      exitPrice: input.exitPrice,
      profit: input.profit,
      riskDollars,
      rMultiple,
      reason: input.reason,
      closedAt: input.closedAt,
      context,
    };

    state.entries = state.entries.filter((e) => e.id !== entry.id);
    state.entries.push(entry);
    this.persist();
    return entry;
  }

  all(): JournalEntry[] {
    return this.load().entries.slice().sort((a, b) => b.closedAt - a.closedAt);
  }

  /** Called from the execute route (approved/expired/blocked) and the reject route
   * (rejected) -- purely a recording step, never gates or alters execution itself. */
  recordSignalOutcome(outcome: SignalOutcome): void {
    const state = this.load();
    state.signalOutcomes.push(outcome);
    this.persist();
  }

  allSignalOutcomes(): SignalOutcome[] {
    return this.load().signalOutcomes.slice().sort((a, b) => b.timestamp - a.timestamp);
  }
}

const globalKey = Symbol.for("forex-ai.tradeJournal");
type GlobalWithStore = typeof globalThis & { [globalKey]?: TradeJournalStore };
const g = globalThis as GlobalWithStore;

export const tradeJournal: TradeJournalStore = g[globalKey] ?? (g[globalKey] = new TradeJournalStore());

export interface PerformanceFilter {
  pair?: Pair;
  timeframe?: Timeframe;
  session?: Session;
  regime?: MarketRegime;
  /** true = only entries whose Signer B direction matched the trade's own direction at
   * signal time (only meaningful for entries with a real, non-null context). */
  signerBAgreement?: boolean;
}

export interface PerformanceStats {
  count: number;
  wins: number;
  losses: number;
  /** 0-100. 0 (not NaN) when count is 0 -- an honest "nothing to report" rather than
   * an undefined-looking value. */
  winRate: number;
  /** Null when no entry in the filtered set has a computed rMultiple. */
  averageR: number | null;
  /** Largest peak-to-trough drop in cumulative R across the filtered entries, in
   * chronological order. Null under the same condition as averageR. */
  maxDrawdownR: number | null;
}

/**
 * Pure aggregation over already-recorded entries -- this is what turns "my AI is 90%
 * accurate" into a real, falsifiable number instead of a claim (see this feature's own
 * motivation). Entries with a null rMultiple (context/price data unavailable at close
 * time) are still counted toward win/loss (profit itself is always real), just
 * excluded from the R-based figures.
 */
export function getPerformanceStats(entries: JournalEntry[], filter: PerformanceFilter = {}): PerformanceStats {
  const filtered = entries.filter((e) => {
    if (filter.pair && e.pair !== filter.pair) return false;
    if (filter.timeframe && e.timeframe !== filter.timeframe) return false;
    if (filter.session && e.context?.session !== filter.session) return false;
    if (filter.regime && e.context?.regime !== filter.regime) return false;
    if (filter.signerBAgreement !== undefined) {
      const agreed = e.context?.signerBDirection === e.direction;
      if (agreed !== filter.signerBAgreement) return false;
    }
    return true;
  });

  const count = filtered.length;
  const wins = filtered.filter((e) => e.profit > 0).length;
  const losses = filtered.filter((e) => e.profit < 0).length;
  const winRate = count === 0 ? 0 : (wins / count) * 100;

  const rValues = filtered
    .slice()
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((e) => e.rMultiple)
    .filter((r): r is number => r !== null);

  const averageR = rValues.length === 0 ? null : rValues.reduce((sum, r) => sum + r, 0) / rValues.length;

  let maxDrawdownR: number | null = null;
  if (rValues.length > 0) {
    let cumulative = 0;
    let peak = 0;
    let maxDrop = 0;
    for (const r of rValues) {
      cumulative += r;
      peak = Math.max(peak, cumulative);
      maxDrop = Math.max(maxDrop, peak - cumulative);
    }
    maxDrawdownR = maxDrop;
  }

  return { count, wins, losses, winRate, averageR, maxDrawdownR };
}

export interface SignalFunnelStats {
  approved: number;
  rejected: number;
  expired: number;
  blocked: number;
}

/** Pure aggregation over signal decisions (not trade outcomes) -- this is the "AI
 * signal performance" half of the split from getPerformanceStats' "actual executed
 * trade performance" half (see SignalOutcome's own doc comment). */
export function getSignalFunnelStats(outcomes: SignalOutcome[]): SignalFunnelStats {
  return {
    approved: outcomes.filter((o) => o.outcome === "approved").length,
    rejected: outcomes.filter((o) => o.outcome === "rejected").length,
    expired: outcomes.filter((o) => o.outcome === "expired").length,
    blocked: outcomes.filter((o) => o.outcome === "blocked").length,
  };
}
