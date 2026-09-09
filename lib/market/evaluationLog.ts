import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { evaluationLog as evaluationLogTable } from "../db/tradingSchema";
import type { Pair, SignalEvaluation, Timeframe } from "./types";
import { pipelineStages, type PipelineStage } from "./noTradeReason";
import { sendNotification } from "./pushNotifier";

// How long a row survives before startEvaluationLogPruning removes it. Generous enough
// to browse "what happened this week", bounded enough that this genuinely high-volume
// table (every SIGNAL_TIMEFRAMES/15m candle close, per pair, per engine -- roughly
// 2000-2500 rows/day across all 9 pairs) never grows without limit the way the low-volume
// tables elsewhere in this schema (processedDeals, journalSignalOutcomes) safely don't
// need to worry about.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface EvaluationLogEntry {
  id: string;
  pair: Pair;
  timeframe: Timeframe;
  source: "smc" | "mean_reversion" | "trend_continuation";
  status: "signal" | "no_trade";
  reasonCode: string | null;
  reasonDetail: Record<string, unknown> | null;
  signalTier: string | null;
  signalConfidence: number | null;
  pipelineStages: PipelineStage[];
  createdAt: number;
}

/**
 * Fire-and-forget, best-effort persistence for ONE evaluation -- called from
 * ingestCandle (metaApiConnection.ts) right alongside predictionStore.set, at the exact
 * same two call sites (SMC's SIGNAL_TIMEFRAMES block, the range engine's 15m block).
 * predictionStore only ever keeps the latest evaluation per pair/timeframe/source in
 * memory; this is what makes "what did this signal actually go through" answerable
 * after the fact instead of only in the moment. Never awaited by its caller and never
 * throws outward -- a logging failure must not affect live signal generation, the exact
 * same posture tradeJournal.ts's own persistEntry already takes.
 */
export async function logEvaluation(
  pair: Pair,
  timeframe: Timeframe,
  source: "smc" | "mean_reversion" | "trend_continuation",
  evaluation: SignalEvaluation,
  time: number
): Promise<void> {
  // Recorded unconditionally, before the DB-availability check below -- the health
  // monitor tracks that evaluations are actually HAPPENING, which has nothing to do
  // with whether DATABASE_URL is configured to persist them.
  recordHeartbeat();

  const db = getOptionalDb();
  if (!db) return;

  const stages = pipelineStages(evaluation, source);
  const signal = evaluation.status === "signal" ? evaluation.signal : null;

  await db
    .insert(evaluationLogTable)
    .values({
      id: randomUUID(),
      pair,
      timeframe,
      source,
      status: evaluation.status,
      reasonCode: evaluation.status === "no_trade" ? evaluation.reason.code : null,
      reasonDetail: evaluation.status === "no_trade" ? (evaluation.reason as unknown as Record<string, unknown>) : null,
      signalTier: signal?.tier ?? null,
      signalConfidence: signal?.confidence ?? null,
      pipelineStages: stages,
      createdAt: new Date(time),
    })
    .catch((error: unknown) => console.error(`[evaluationLog] failed to persist ${pair} ${timeframe} ${source} evaluation:`, error));
}

export interface EvaluationLogQuery {
  pair?: Pair;
  source?: "smc" | "mean_reversion" | "trend_continuation";
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Read path for the history API route -- most recent first, optionally filtered by
 * pair and/or source. Returns [] (not an error) when DATABASE_URL isn't configured,
 * same "gracefully absent, never a hard failure" posture as every other optional-DB
 * read in this codebase. */
export async function getEvaluationHistory(query: EvaluationLogQuery): Promise<EvaluationLogEntry[]> {
  const db = getOptionalDb();
  if (!db) return [];

  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = [];
  if (query.pair) conditions.push(eq(evaluationLogTable.pair, query.pair));
  if (query.source) conditions.push(eq(evaluationLogTable.source, query.source));

  const rows = await db
    .select()
    .from(evaluationLogTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(evaluationLogTable.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    pair: row.pair as Pair,
    timeframe: row.timeframe as Timeframe,
    source: row.source as "smc" | "mean_reversion" | "trend_continuation",
    status: row.status as "signal" | "no_trade",
    reasonCode: row.reasonCode,
    reasonDetail: row.reasonDetail,
    signalTier: row.signalTier,
    signalConfidence: row.signalConfidence,
    pipelineStages: row.pipelineStages,
    createdAt: row.createdAt.getTime(),
  }));
}

export interface EvaluationSummary {
  totalEvaluated: number;
  qualified: number;
  rejected: number;
  /** Ordered highest-count first -- real reasonCode counts among rejected evaluations
   * only, never fabricated categories. */
  topBlockers: { reasonCode: string; count: number }[];
}

/**
 * "Why no trade" over a real time window -- a direct aggregate COUNT/GROUP BY, not a
 * client-side reduction over getEvaluationHistory's row-limited results (this table is
 * high-volume enough, ~2000-2500 rows/day, that a 24h window can hold tens of thousands
 * of rows -- see this file's own RETENTION_MS comment). Built for maintenanceCheck.ts's
 * real health scan (operator request, 2026-09-09). Returns all-zero, not an error, when
 * DATABASE_URL isn't configured -- same posture as every other optional-DB read here.
 */
export async function getEvaluationSummary(sinceMs: number): Promise<EvaluationSummary> {
  const db = getOptionalDb();
  if (!db) return { totalEvaluated: 0, qualified: 0, rejected: 0, topBlockers: [] };

  const since = new Date(sinceMs);
  const statusCounts = await db
    .select({ status: evaluationLogTable.status, count: sql<string>`count(*)` })
    .from(evaluationLogTable)
    .where(gte(evaluationLogTable.createdAt, since))
    .groupBy(evaluationLogTable.status);

  const qualified = Number(statusCounts.find((r) => r.status === "signal")?.count ?? 0);
  const rejected = Number(statusCounts.find((r) => r.status === "no_trade")?.count ?? 0);

  const blockerRows = await db
    .select({ reasonCode: evaluationLogTable.reasonCode, count: sql<string>`count(*)` })
    .from(evaluationLogTable)
    .where(and(gte(evaluationLogTable.createdAt, since), eq(evaluationLogTable.status, "no_trade")))
    .groupBy(evaluationLogTable.reasonCode)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  const topBlockers = blockerRows.filter((r) => r.reasonCode !== null).map((r) => ({ reasonCode: r.reasonCode as string, count: Number(r.count) }));

  return { totalEvaluated: qualified + rejected, qualified, rejected, topBlockers };
}

const globalKey = Symbol.for("forex-ai.evaluationLog.pruneState");
type GlobalWithPruneState = typeof globalThis & { [globalKey]?: { intervalStarted: boolean } };
const g = globalThis as GlobalWithPruneState;
const pruneState = g[globalKey] ?? (g[globalKey] = { intervalStarted: false });

async function pruneOnce(): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db.delete(evaluationLogTable).where(lt(evaluationLogTable.createdAt, new Date(Date.now() - RETENTION_MS)));
}

/** Called once from bootstrap.ts. Idempotent (intervalStarted guard) -- safe to call on
 * every boot without spawning a second interval, same pattern as
 * higherTimeframeRefresh.ts's own startHigherTimeframeRefresh. */
export function startEvaluationLogPruning(): void {
  if (pruneState.intervalStarted) return;
  pruneState.intervalStarted = true;
  setInterval(() => {
    void pruneOnce().catch((error: unknown) => console.error("[evaluationLog] pruning failed:", error));
  }, PRUNE_INTERVAL_MS);
}

// --- Health monitor: catches the analysis pipeline going silent even when the MT5
// connection itself reads perfectly healthy (an uncaught exception or stuck async chain
// inside ingestCandle, as opposed to connectionWatchdog.ts's own concern -- a dead
// broker connection). SIGNAL_TIMEFRAMES (15m/30m/1h) means SOME pair's SMC evaluation
// should complete at least every 15 minutes in ordinary operation (15m candles across
// all 9 pairs close on the same wall-clock boundaries); a 25-minute silence is already
// well beyond that with real margin, and 10-minute checks catch it reasonably promptly
// without being wasteful.

const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const STALL_THRESHOLD_MS = 25 * 60 * 1000;

interface HealthState {
  lastEvaluationAt: number | null;
  bootedAt: number;
  alertActive: boolean;
  intervalStarted: boolean;
}
const healthGlobalKey = Symbol.for("forex-ai.evaluationLog.healthState");
type GlobalWithHealthState = typeof globalThis & { [healthGlobalKey]?: HealthState };
const gHealth = globalThis as GlobalWithHealthState;
const healthState: HealthState =
  gHealth[healthGlobalKey] ?? (gHealth[healthGlobalKey] = { lastEvaluationAt: null, bootedAt: Date.now(), alertActive: false, intervalStarted: false });

/** Called from every logEvaluation, unconditionally -- the one place in the codebase
 * that fires on every completed SMC/range evaluation, which is exactly the heartbeat
 * this monitor needs. Also clears (and announces the recovery of) an active alert, the
 * same "tell me the moment it's not wrong anymore" posture positionRiskNarration.ts
 * already established for Caution/Warning clearing. */
function recordHeartbeat(): void {
  const wasAlerting = healthState.alertActive;
  healthState.lastEvaluationAt = Date.now();
  healthState.alertActive = false;
  if (wasAlerting) {
    void sendNotification({
      category: "engine_health",
      title: "JUDE AI — Autopilot analysis resumed",
      body: "The signal engine is completing evaluations again after a gap.",
    });
  }
}

function checkEvaluationHealth(): void {
  if (healthState.alertActive) return;
  const baseline = healthState.lastEvaluationAt ?? healthState.bootedAt;
  const stalledMs = Date.now() - baseline;
  if (stalledMs <= STALL_THRESHOLD_MS) return;

  healthState.alertActive = true;
  const stalledMinutes = Math.round(stalledMs / 60000);
  void sendNotification({
    category: "engine_health",
    title: "JUDE AI — Autopilot health warning",
    body: `No market analysis has completed in over ${stalledMinutes} minutes, even though this can normally be expected every 15. The signal engine may be stuck -- check the MT5 connection status on the dashboard.`,
  });
}

/** Called once from bootstrap.ts. Idempotent, same pattern as every other periodic task
 * in this file. */
export function startEvaluationHealthMonitor(): void {
  if (healthState.intervalStarted) return;
  healthState.intervalStarted = true;
  setInterval(checkEvaluationHealth, HEALTH_CHECK_INTERVAL_MS);
}
