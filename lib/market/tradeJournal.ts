import { desc, eq, gte } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import {
  journalEntries as journalEntriesTable,
  journalPendingContexts as journalPendingContextsTable,
  journalSignalOutcomes as journalSignalOutcomesTable,
} from "../db/tradingSchema";
import {
  CONFLUENCES,
  type AccountKey,
  type Confluence,
  type MarketRegime,
  type OpenPosition,
  type Pair,
  type Session,
  type Signal,
  type Timeframe,
} from "./types";
import { tierOf, type DimensionTier } from "./confidenceScore";
import type { SetupQualityBreakdown } from "./setupQualityScore";
import { pipSize } from "./symbols";
import { pipValuePerLot } from "./pipValue";

// A trade can stay open far longer than signalStore's own 4-hour prune window
// (STALE_AFTER_MS) -- that's exactly why the decision-context snapshot below can't
// just reuse signalStore. 30 days comfortably covers any realistic hold time for this
// app's SMC-style setups.
const CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Bounds how much hydrate() below reloads into memory at boot -- generous relative to
// realistic trade/decision volume (a handful of trades/day at most, given SMC's own
// selectivity), same "bound what's reloaded" reasoning as positionStore.ts's own
// MAX_RECORDS. Unlike positionStore, there's no ONGOING eviction of entries/
// signalOutcomes once loaded (this store's prior file-based version never pruned these
// either) -- only pendingContexts gets ongoing pruning, since it's a genuinely
// time-bounded working set (see pruneContexts below).
const HYDRATE_LIMIT = 5000;

/** The decision context at the moment a signal fired -- snapshotted separately from
 * the live `Signal` object (which is pruned after 4 hours) so it survives until the
 * trade it may lead to actually closes, however long that takes. */
export interface SignalContext {
  signalId: string;
  pair: Pair;
  timeframe: Timeframe;
  direction: "long" | "short";
  regime: MarketRegime;
  /** Optional -- SMC-shaped (see scoreSetupQuality's own doc comment on why it would be
   * a meaningless score for a mean-reversion setup), so the range engine's own context
   * simply omits it rather than computing a number that doesn't mean what it looks like
   * it means. Entries recorded before this field existed also simply have it undefined. */
  setupQuality?: SetupQualityBreakdown;
  confidence: number;
  signerBDirection: Signal["signerBDirection"];
  signerBConfidence: number;
  adx: number;
  rsi: number;
  newsStatus: Signal["newsStatus"];
  session: Session;
  createdAt: number;
  /** Optional -- entries recorded before this field existed simply have it undefined
   * (old rows in the DB predate the column's use), never a fabricated guess at which
   * confluences were present. */
  confluences?: Confluence[];
  /** Which engine produced the signal (see types.ts's SignalSource) -- optional because
   * entries recorded before this field existed simply have it undefined, same posture as
   * confluences above. getPerformanceBreakdown's "source" dimension excludes those, the
   * same way it already excludes any other context-less entry. */
  source?: Signal["source"];
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

async function persistContext(context: SignalContext): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  const row = { signalId: context.signalId, createdAt: new Date(context.createdAt), context: context as unknown as Record<string, unknown> };
  await db.insert(journalPendingContextsTable).values(row).onConflictDoUpdate({ target: journalPendingContextsTable.signalId, set: row });
}

async function deletePersistedContext(signalId: string): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db.delete(journalPendingContextsTable).where(eq(journalPendingContextsTable.signalId, signalId));
}

async function persistEntry(entry: JournalEntry): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  const row = {
    id: entry.id,
    signalId: entry.signalId,
    account: entry.account,
    pair: entry.pair,
    timeframe: entry.timeframe,
    direction: entry.direction,
    entryPrice: entry.entryPrice,
    exitPrice: entry.exitPrice,
    profit: entry.profit,
    riskDollars: entry.riskDollars,
    rMultiple: entry.rMultiple,
    reason: entry.reason,
    closedAt: new Date(entry.closedAt),
    context: entry.context as unknown as Record<string, unknown> | null,
  };
  await db.insert(journalEntriesTable).values(row).onConflictDoUpdate({ target: journalEntriesTable.id, set: row });
}

async function persistSignalOutcome(outcome: SignalOutcome): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db.insert(journalSignalOutcomesTable).values({
    signalId: outcome.signalId,
    pair: outcome.pair,
    outcome: outcome.outcome,
    reason: outcome.reason,
    timestamp: new Date(outcome.timestamp),
  });
}

/**
 * In-memory Maps/array are the real, synchronous source of truth (same reasoning as
 * positionStore.ts's own class doc) -- every read/write here is a plain in-memory
 * operation with zero latency, matching this store's prior file-based behavior exactly
 * from every caller's point of view. Postgres (via lib/db/optionalClient.ts) is a
 * best-effort durability backstop: writes fire-and-forget, and hydrate() (called once
 * at boot, see bootstrap.ts) reloads recent history back into memory so a restart
 * doesn't lose it -- replacing this store's old plain-JSON-file-on-disk approach, which
 * doesn't survive a Railway redeploy the way a real database does.
 */
class TradeJournalStore {
  private pendingContexts = new Map<string, SignalContext>();
  private entries = new Map<string, JournalEntry>();
  private signalOutcomes: SignalOutcome[] = [];

  /** Called once per fired signal (see metaApiConnection.ts, right alongside
   * publishSignal) -- never called from anywhere execution/risk-relevant, purely a
   * recording step. */
  recordSignalContext(context: SignalContext): void {
    this.pendingContexts.set(context.signalId, context);
    this.pruneContexts();
    void persistContext(context).catch((error: unknown) => {
      console.error(`[tradeJournal] failed to persist signal context ${context.signalId}:`, error);
    });
  }

  // Only prunes the in-memory working set, same as positionStore.ts's own prune() --
  // the DB row for a pruned-for-age context isn't actively deleted (see
  // deletePersistedContext, only called when a context is actually consumed below);
  // hydrate()'s own age filter simply never reloads it back in on the next boot.
  private pruneContexts(): void {
    const cutoff = Date.now() - CONTEXT_RETENTION_MS;
    for (const [signalId, context] of this.pendingContexts) {
      if (context.createdAt < cutoff) this.pendingContexts.delete(signalId);
    }
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

    const context = this.pendingContexts.get(input.signalId) ?? null;
    if (context) {
      this.pendingContexts.delete(input.signalId);
      void deletePersistedContext(input.signalId).catch((error: unknown) => {
        console.error(`[tradeJournal] failed to delete consumed signal context ${input.signalId}:`, error);
      });
    }

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

    this.entries.set(entry.id, entry);
    void persistEntry(entry).catch((error: unknown) => {
      console.error(`[tradeJournal] failed to persist journal entry ${entry.id}:`, error);
    });
    return entry;
  }

  all(): JournalEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.closedAt - a.closedAt);
  }

  /** Called from the execute route (approved/expired/blocked) and the reject route
   * (rejected) -- purely a recording step, never gates or alters execution itself. */
  recordSignalOutcome(outcome: SignalOutcome): void {
    this.signalOutcomes.push(outcome);
    void persistSignalOutcome(outcome).catch((error: unknown) => {
      console.error(`[tradeJournal] failed to persist signal outcome for ${outcome.signalId}:`, error);
    });
  }

  allSignalOutcomes(): SignalOutcome[] {
    return this.signalOutcomes.slice().sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Reloads recent history from the DB into memory -- called once at boot (see
   * bootstrap.ts) so a restart doesn't lose the journal. No-ops when DATABASE_URL isn't
   * set. Bypasses the record*() methods deliberately -- these rows already exist in the
   * DB, so re-persisting them on load would just be a wasted round trip (same reasoning
   * as positionStore.ts's own hydrate()). */
  async hydrate(): Promise<void> {
    const db = getOptionalDb();
    if (!db) return;

    const cutoff = new Date(Date.now() - CONTEXT_RETENTION_MS);
    const [contextRows, entryRows, outcomeRows] = await Promise.all([
      db.select().from(journalPendingContextsTable).where(gte(journalPendingContextsTable.createdAt, cutoff)),
      db.select().from(journalEntriesTable).orderBy(desc(journalEntriesTable.closedAt)).limit(HYDRATE_LIMIT),
      db.select().from(journalSignalOutcomesTable).orderBy(desc(journalSignalOutcomesTable.timestamp)).limit(HYDRATE_LIMIT),
    ]);

    for (const row of contextRows) {
      if (!this.pendingContexts.has(row.signalId)) {
        this.pendingContexts.set(row.signalId, row.context as unknown as SignalContext);
      }
    }
    for (const row of entryRows) {
      if (!this.entries.has(row.id)) {
        this.entries.set(row.id, {
          id: row.id,
          signalId: row.signalId,
          account: row.account as AccountKey,
          pair: row.pair as Pair,
          timeframe: (row.timeframe as Timeframe | null) ?? undefined,
          direction: row.direction as "long" | "short",
          entryPrice: row.entryPrice,
          exitPrice: row.exitPrice,
          profit: row.profit,
          riskDollars: row.riskDollars,
          rMultiple: row.rMultiple,
          reason: row.reason as JournalCloseReason,
          closedAt: row.closedAt.getTime(),
          context: row.context as unknown as SignalContext | null,
        });
      }
    }
    for (const row of outcomeRows) {
      this.signalOutcomes.push({
        signalId: row.signalId,
        pair: row.pair as Pair,
        outcome: row.outcome as SignalOutcomeType,
        reason: row.reason,
        timestamp: row.timestamp.getTime(),
      });
    }
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
  /** Gross profit / gross loss (both in account currency, loss taken as a positive
   * magnitude) -- unlike averageR, this uses real profit dollars, not the R-normalized
   * figure, so it isn't skipped just because rMultiple couldn't be computed for some
   * entries. Null when there are no losing trades to divide by (including when count is
   * 0) -- a bare 0 there would misleadingly read as "breakeven" rather than "undefined",
   * and Infinity would misrender in the UI. */
  profitFactor: number | null;
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

  const grossProfit = filtered.filter((e) => e.profit > 0).reduce((sum, e) => sum + e.profit, 0);
  const grossLoss = filtered.filter((e) => e.profit < 0).reduce((sum, e) => sum + -e.profit, 0);
  const profitFactor = grossLoss === 0 ? null : Number((grossProfit / grossLoss).toFixed(2));

  return { count, wins, losses, winRate, averageR, maxDrawdownR, profitFactor };
}

/**
 * Groups entries by pair, session, or market regime and runs getPerformanceStats over
 * each bucket -- the aggregate "stats" figure answers "am I profitable", this answers
 * "which pairs/sessions/regimes is that actually coming from". Entries with no context
 * (aged-out/predates this feature) are simply excluded from the "session"/"regime"
 * groupings (there's nothing to group them by), same null-handling getPerformanceStats
 * itself already does for a session/regime filter -- they still count toward the
 * aggregate stats, just not this breakdown. "regime" is also, as a side effect,
 * effectively SMC-only: context is only ever recorded from the internal SMC engine loop
 * (see recordSignalContext's call site in metaApiConnection.ts) -- a TradingView-sourced
 * entry has no context at all, so it's excluded the same way an aged-out one is, never
 * needing a separate source check. "source" (which engine -- SMC vs. mean-reversion --
 * produced the signal) is the one dimension NOT SMC-only: it's recorded for every engine
 * that calls recordSignalContext, including the range engine's own call site. Entries
 * that predate the `source` field (or a TradingView-sourced entry with no context at
 * all) are excluded from this dimension specifically, same as any other missing-context
 * case above.
 */
export function getPerformanceBreakdown(
  entries: JournalEntry[],
  dimension: "pair" | "session" | "regime" | "source"
): Record<string, PerformanceStats> {
  const buckets = new Map<string, JournalEntry[]>();
  for (const entry of entries) {
    const key =
      dimension === "pair"
        ? entry.pair
        : dimension === "session"
          ? entry.context?.session
          : dimension === "regime"
            ? entry.context?.regime
            : entry.context?.source;
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  const breakdown: Record<string, PerformanceStats> = {};
  for (const [key, bucketEntries] of buckets) {
    breakdown[key] = getPerformanceStats(bucketEntries);
  }
  return breakdown;
}

export const DEFAULT_DURATION_MIN_SAMPLES = 5;

export interface DurationBucket {
  sampleSize: number;
  status: CalibrationStatus;
  /** Median wall-clock time from signal creation (context.createdAt) to close
   * (closedAt), in ms -- median rather than mean, since trade duration is typically
   * right-skewed (a handful of trades held open far longer than typical would pull a
   * mean well away from what "typical" actually looks like). Null when status is
   * "insufficient_data" -- same "never a misleadingly-precise figure from too few
   * trades" posture as ConfidenceCalibrationBucket's own winRate/averageR. */
  medianMs: number | null;
  /** 25th/75th percentile duration -- a real "typical window" (most past trades in
   * this bucket resolved somewhere between these two), not a bare min/max, which a
   * single unusually-fast or unusually-slow trade would blow out to something no
   * longer representative of "typical". Both null under the same condition as
   * medianMs. Powers the mobile/web "caution" read on an open position: still open
   * well past p75Ms of the stop-loss bucket while currently losing is a real,
   * data-grounded signal worth a manual look -- never an automated close. */
  p25Ms: number | null;
  p75Ms: number | null;
}

export interface DurationStats {
  takeProfit: DurationBucket;
  stopLoss: DurationBucket;
}

/** Linear-interpolated percentile over an already-sorted array (the standard
 * "R-7"/Excel-style method) -- p in [0, 1]. */
function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function durationsFor(entries: JournalEntry[], filter: PerformanceFilter, reason: "take_profit" | "stop_loss"): number[] {
  return entries
    .filter((e) => {
      if (e.reason !== reason || !e.context) return false;
      if (filter.pair && e.pair !== filter.pair) return false;
      if (filter.timeframe && e.timeframe !== filter.timeframe) return false;
      if (filter.session && e.context.session !== filter.session) return false;
      if (filter.regime && e.context.regime !== filter.regime) return false;
      if (filter.signerBAgreement !== undefined) {
        const agreed = e.context.signerBDirection === e.direction;
        if (agreed !== filter.signerBAgreement) return false;
      }
      return true;
    })
    .map((e) => e.closedAt - e.context!.createdAt)
    // A non-positive duration can only mean bad/clock-skewed data (a close can't
    // predate its own signal) -- excluded rather than let it drag a median toward
    // zero, same "never let a data anomaly masquerade as a real reading" posture the
    // rest of this app already follows (see e.g. metaApiConnection.ts's spread-cost
    // guards).
    .filter((ms) => ms > 0);
}

function durationBucket(durations: number[], minSamples: number): DurationBucket {
  const sampleSize = durations.length;
  const status: CalibrationStatus = sampleSize >= minSamples ? "calibrated" : "insufficient_data";
  if (status !== "calibrated") return { sampleSize, status, medianMs: null, p25Ms: null, p75Ms: null };
  const sorted = durations.slice().sort((a, b) => a - b);
  return { sampleSize, status, medianMs: percentile(sorted, 0.5), p25Ms: percentile(sorted, 0.25), p75Ms: percentile(sorted, 0.75) };
}

/**
 * How long similar past trades actually took to resolve, split by which way they
 * resolved -- "how long has this typically taken to reach take-profit" vs "how long
 * before a losing trade typically hits its stop", both grounded in real closed trades
 * (JournalEntry, shared by live executions and backtest-derived entries alike). This
 * is deliberately NOT a time-to-target prediction for the live open signal itself (the
 * signal engine makes no such estimate, see PriceChart.tsx's forecast curve doc
 * comment) -- it's a historical read on setups like this one, presented as exactly
 * that. Below minSamples, honestly reports "insufficient_data" rather than a number
 * computed from too few trades to mean anything, same posture as
 * getConfidenceCalibration.
 */
export function computeDurationStats(
  entries: JournalEntry[],
  filter: PerformanceFilter = {},
  minSamples = DEFAULT_DURATION_MIN_SAMPLES
): DurationStats {
  return {
    takeProfit: durationBucket(durationsFor(entries, filter, "take_profit"), minSamples),
    stopLoss: durationBucket(durationsFor(entries, filter, "stop_loss"), minSamples),
  };
}

/**
 * Whether an open, currently-losing position has already run longer than 75% of past
 * losses on this pair took to hit their own stop -- a real, data-grounded "this is
 * taking longer than usual to turn around" cue (see this feature's own request: "enable
 * me to stop the trade if it's moving out of my direction"). Mirrored client-side in
 * PositionsPanel.tsx (web) and PositionsList.tsx (mobile) for the on-screen caution
 * banner; this copy is what metaApiConnection.ts's candle-close loop calls to decide
 * whether to push-notify -- same predicate, evaluated server-side so it can fire even
 * while the app isn't open. Requires openedAt (undefined for a position opened outside
 * either app) and a calibrated stop-loss bucket; returns false, never a guess, when
 * either is missing.
 */
export function isRunningLongForALoss(position: OpenPosition, stats: DurationStats, now: number): boolean {
  if (position.profit >= 0 || position.openedAt === undefined) return false;
  if (stats.stopLoss.status !== "calibrated" || stats.stopLoss.p75Ms === null) return false;
  return now - position.openedAt > stats.stopLoss.p75Ms;
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

// Same "invalid/unset -> safe fallback" posture as executionConfig.ts's own envNumber --
// a non-positive or non-numeric override can't mean anything sensible here. Single
// source of truth for this threshold -- both the web /settings page and
// /api/trade-journal (for mobile) call this rather than each guessing their own copy.
export function defaultCalibrationMinSamples(): number {
  const raw = Number(process.env.CONFIDENCE_CALIBRATION_MIN_SAMPLES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export type CalibrationStatus = "calibrated" | "insufficient_data";

export interface ConfidenceCalibrationBucket {
  tier: "buy" | "strong_buy";
  sampleSize: number;
  status: CalibrationStatus;
  /** 0-100. Null when status is "insufficient_data" -- a number here always means it's
   * backed by at least minSamples real closed trades, never a misleadingly-precise
   * figure from a handful of them. */
  winRate: number | null;
  averageR: number | null;
  /** Same value as averageR -- the average R multiple across all trades (wins and
   * losses together) already IS expectancy in R terms, so this isn't a second
   * computation, just the same number under the name this is normally asked for by. */
  expectancy: number | null;
}

/**
 * Buckets by the signal's own final tier at the moment it fired (context.confidence,
 * the same 80/90 boundaries confidenceScore.ts's tierOf already uses) rather than finer
 * numeric ranges -- every real fired signal in this app has confidence in the buy/
 * strong_buy range (80-100) only (watch-tier, 70-79, never executes; nothing below 70
 * ever becomes a Signal at all, see signalEngine.ts), so finer buckets would only
 * fragment an already-small sample further. Entries with no context (predates this
 * feature, or aged out past CONTEXT_RETENTION_MS) are excluded -- there's no confidence
 * to bucket them by, and guessing one would defeat the entire point of calibrating
 * against real data.
 *
 * Reuses getPerformanceStats' own win-rate/average-R math over each bucket rather than
 * reimplementing it. Feeds positionSizing.ts's confidenceAdjustedRiskPct once a tier
 * clears the sample-size bar (real measured expectancy replaces the manual
 * riskMultiplierBuy/riskMultiplierStrongBuy config value for that tier specifically) --
 * before that, "insufficient_data" is exactly what keeps sizing on the manual value.
 */
export function getConfidenceCalibration(entries: JournalEntry[], minSamples: number): ConfidenceCalibrationBucket[] {
  const withContext = entries.filter((e): e is JournalEntry & { context: SignalContext } => e.context !== null);

  return (["buy", "strong_buy"] as const).map((tier) => {
    // Reuses tierOf rather than a hardcoded confidence cutoff, so this stays in sync
    // with confidenceScore.ts's actual STRONG_BUY_THRESHOLD if it's ever tuned again --
    // a literal duplicate number here already drifted silently out of sync once.
    const bucketEntries = withContext.filter((e) => tierOf(e.context.confidence) === tier);
    const sampleSize = bucketEntries.length;
    const status: CalibrationStatus = sampleSize >= minSamples ? "calibrated" : "insufficient_data";

    if (status === "insufficient_data") {
      return { tier, sampleSize, status, winRate: null, averageR: null, expectancy: null };
    }

    const stats = getPerformanceStats(bucketEntries);
    return { tier, sampleSize, status, winRate: stats.winRate, averageR: stats.averageR, expectancy: stats.averageR };
  });
}

// Progress checkpoints toward a tier's own minSamples bar -- purely informational (see
// calibrationMilestoneNotifications' own doc comment), same three fixed checkpoints
// regardless of how far minSamples itself is configured.
const CALIBRATION_MILESTONES = new Set([10, 20, 30]);

export interface CalibrationMilestoneNotification {
  tier: "buy" | "strong_buy";
  title: string;
  body: string;
}

/**
 * Pure. Which (if any) calibration buckets just crossed a real closed-trade milestone
 * (10/20/30) toward getConfidenceCalibration's own minSamples bar -- called once per
 * newly-recorded outcome (see metaApiConnection.ts's onDealAdded), so a bucket's
 * sampleSize only ever increases by exactly one per call and can land on a given
 * milestone at most once as it climbs, never skip over it or re-trigger later.
 *
 * Purely informational, same "narrate, never touch scoring" posture as every other
 * notification in this app -- getConfidenceCalibration/positionSizing.ts's own
 * confidenceAdjustedRiskPct are completely unaffected by this; it only ever reads the
 * same numbers Settings' own calibration panel already shows.
 */
export function calibrationMilestoneNotifications(
  buckets: ConfidenceCalibrationBucket[],
  minSamples: number
): CalibrationMilestoneNotification[] {
  return buckets
    .filter((bucket) => CALIBRATION_MILESTONES.has(bucket.sampleSize))
    .map((bucket) => {
      const label = bucket.tier === "strong_buy" ? "Strong buy" : "Buy";
      const body =
        bucket.sampleSize >= minSamples
          ? `${label} tier just reached ${bucket.sampleSize} real closed trades -- calibration data is now available in Settings.`
          : `${label} tier: ${bucket.sampleSize}/${minSamples} real closed trades toward calibration.`;
      return { tier: bucket.tier, title: `JUDE AI — Calibration progress: ${label}`, body };
    });
}

export interface SignerBCalibrationBucket {
  tier: DimensionTier;
  sampleSize: number;
  status: CalibrationStatus;
  winRate: number | null;
  averageR: number | null;
  expectancy: number | null;
}

/**
 * The "is Signer B actually pulling its weight, or just rubber-stamping Signer A"
 * scorecard -- same measurement as getConfidenceCalibration, but bucketed by Signer B's
 * OWN independent confidence (context.signerBConfidence) instead of the fired signal's
 * SMC-derived confidence (context.confidence). These are genuinely different numbers:
 * decisionMatrix.ts's combineSigners only ever requires Signer B to AGREE on direction
 * to let a signal through, never any confidence floor -- "a merely-lower Signer B
 * confidence while still agreeing on direction... never blocks". So unlike Signer A
 * (gated at buy/90+ by construction of what becomes a Signal at all, see
 * getConfidenceCalibration's own comment), Signer B's confidence on a fired signal can
 * genuinely land in ANY of tierOf's four tiers -- all four are bucketed here, not just
 * buy/strong_buy. A real difference in win rate/average R across these tiers means
 * Signer B's strength of conviction (not just its yes/no agreement, which is always
 * "yes" on a fired signal) is real, independent signal -- not decoration.
 */
export function getSignerBCalibration(entries: JournalEntry[], minSamples: number): SignerBCalibrationBucket[] {
  const withContext = entries.filter((e): e is JournalEntry & { context: SignalContext } => e.context !== null);
  const tiers: DimensionTier[] = ["no_trade", "watch", "buy", "strong_buy"];

  return tiers.map((tier) => {
    const bucketEntries = withContext.filter((e) => tierOf(e.context.signerBConfidence) === tier);
    const sampleSize = bucketEntries.length;
    const status: CalibrationStatus = sampleSize >= minSamples ? "calibrated" : "insufficient_data";

    if (status === "insufficient_data") {
      return { tier, sampleSize, status, winRate: null, averageR: null, expectancy: null };
    }

    const stats = getPerformanceStats(bucketEntries);
    return { tier, sampleSize, status, winRate: stats.winRate, averageR: stats.averageR, expectancy: stats.averageR };
  });
}

// Below this many closed trades, a confluence's win rate is noise, not edge -- shown
// as "insufficient_data" rather than hidden, same posture as getConfidenceCalibration.
// Lower than that function's own threshold (30): confluences are far more numerous (18
// vs. 2 tiers) and non-exclusive, so each individual bucket naturally gets fewer samples
// for the same total trade count -- a stricter bar here would leave most buckets
// perpetually unratable even with a healthy amount of trading history.
export const DEFAULT_CONFLUENCE_MIN_SAMPLES = 10;

export type ConfluenceStatus = "ok" | "insufficient_data";

export interface ConfluenceBreakdownBucket {
  confluence: Confluence;
  sampleSize: number;
  status: ConfluenceStatus;
  winRate: number | null;
  averageR: number | null;
}

/**
 * "Which confluences actually predict wins" -- buckets closed trades by whether each
 * confluence factor was present on the signal that produced them, and runs
 * getPerformanceStats over each bucket. Unlike getPerformanceBreakdown's pair/session
 * grouping, these buckets are NOT mutually exclusive (a single trade's signal can
 * carry many confluences at once, e.g. both "fvg" and "order_block"), so a trade
 * legitimately contributes to several buckets here. Entries with no context (predates
 * this feature, or aged out) or no confluences recorded (predates the confluences field
 * itself) are excluded -- there's nothing real to bucket them by.
 *
 * Feeds positionSizing.ts's confluenceAdjustedMultiplier once a confluence tag clears
 * the sample-size bar (real measured expectancy scales sizing for signals carrying that
 * tag) -- same "insufficient_data" -> no adjustment posture as getConfidenceCalibration,
 * gated behind its own confluenceSizingEnabled toggle (see executionConfig.ts), off by
 * default.
 */
export function getConfluenceBreakdown(entries: JournalEntry[], minSamples = DEFAULT_CONFLUENCE_MIN_SAMPLES): ConfluenceBreakdownBucket[] {
  const withConfluences = entries.filter((e) => e.context?.confluences !== undefined);

  return CONFLUENCES.map((confluence) => {
    const bucketEntries = withConfluences.filter((e) => e.context!.confluences!.includes(confluence));
    const sampleSize = bucketEntries.length;
    const status: ConfluenceStatus = sampleSize >= minSamples ? "ok" : "insufficient_data";

    if (status === "insufficient_data") {
      return { confluence, sampleSize, status, winRate: null, averageR: null };
    }

    const stats = getPerformanceStats(bucketEntries);
    return { confluence, sampleSize, status, winRate: stats.winRate, averageR: stats.averageR };
  }).sort((a, b) => b.sampleSize - a.sampleSize);
}
