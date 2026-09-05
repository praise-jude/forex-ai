import { randomUUID } from "node:crypto";
import type {
  AnalysisJob,
  AnalysisStage,
  EngineVerdict,
  ExtendedTimeframeTrends,
  Pair,
  PairAnalysisResult,
  SignalEvaluation,
  Timeframe,
} from "./types";
import { candleStore } from "./candleStore";
import { priceStore } from "./priceStore";
import { TIMEFRAME_MS } from "./timeframes";
import { computeSharedGateContext, evaluateDirectionalCandidate, findSweepCandidates, type SharedGateContext } from "./signalEngine";
import { evaluateRangeSignal } from "./rangeEngine";
import { detectMarketRegime } from "./marketRegime";
import { calculateAdx } from "./indicators/adx";
import { calculateAtr } from "./indicators/atr";
import { checkNews } from "./newsFilter";
import { emaTrendDirection } from "./indicators/emaTrend";
import { calculateRsi } from "./indicators/rsi";
import { calculateSupertrend } from "./indicators/supertrend";
import { computeUsdStrength } from "./currencyStrength";
import { getActiveSession } from "./sessions";
import { evaluateSignerB } from "./signerB";
import { checkCorrelatedExposure, checkPriceDrift, checkSpread } from "./riskManager";
import { checkExecutionPolicy, getExecutionPolicy } from "./executionPolicy";
import { loadExecutionConfig } from "./executionConfig";
import { getEngineMode, manualExecutionAccount } from "./engineMode";
import { getOpenPositions } from "./metaApiConnection";

/**
 * Real, named stages of the "Check a Pair" analysis pipeline -- see the mobile/web
 * "Analyze Trade" spec this implements. Every stage here performs genuine additional
 * computation the plain /api/signals/evaluate route does not (dual-direction candidate
 * scoring, an actual Range Engine invocation, a full 15m-1d trend ladder, pre-execution
 * risk validation run early for transparency) -- the job's `stage` field only ever
 * advances once that stage's real work has actually finished, never on a timer. The one
 * timing adjustment is STAGE_MIN_DISPLAY_MS below: a minimum floor so a human can
 * actually read each stage label before the (genuinely fast, CPU-bound) next one
 * finishes -- it never alters what data is attached to a stage, only how long the
 * already-real result is held before advancing.
 *
 * ANALYSIS_STAGE_PCT is the single source of truth for "how far through is stage X" --
 * both mobile and web read this same mapping (via the job's `stage` field) rather than
 * each guessing their own percentages.
 */
export const ANALYSIS_STAGE_PCT: Record<AnalysisStage, number> = {
  market_data: 15,
  structure: 30,
  smc_engine: 45,
  range_engine: 60,
  multi_timeframe: 75,
  consensus: 85,
  risk_validation: 95,
  final: 100,
};

const STAGE_MIN_DISPLAY_MS = 300;
// Same "bound an in-memory ledger, prune the oldest" posture as positionStore.ts's own
// MAX_RECORDS -- a job is short-lived (completes in a couple of seconds at most) and
// never persisted to disk, unlike backtestRunner.ts's BacktestJob, so this only ever
// prunes ancient history from a crashed/abandoned poll.
const MAX_JOBS = 200;
// A candle older than this many bar-intervals since the last close is treated as a real
// stale-data gate, not just "the newest bar hasn't closed yet" -- the live streaming
// connection is expected to keep candleStore continuously current; a gap this large
// means that connection has genuinely fallen behind.
const STALE_DATA_BAR_MULTIPLE = 2;

const jobs = new Map<string, AnalysisJob>();

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const oldest = jobs.keys().next().value;
  if (oldest !== undefined) jobs.delete(oldest);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Advances `job` to `stage`, holding it there for at least STAGE_MIN_DISPLAY_MS from
 * this call so a poller has a real chance to observe it -- see this file's own doc
 * comment on why this is the one place timing (not data) is adjusted. */
async function advanceStage(job: AnalysisJob, stage: AnalysisStage): Promise<void> {
  job.stage = stage;
  job.stageStartedAt = Date.now();
  await sleep(STAGE_MIN_DISPLAY_MS);
}

export function getAnalysisJob(id: string): AnalysisJob | undefined {
  return jobs.get(id);
}

/** Creates a new analysis job and starts it running in the background (fire-and-forget,
 * matching bootstrap.ts's startMarketEngine() pattern) -- returns immediately with the
 * job in its initial "running"/"market_data" state for the caller to start polling. */
export function startAnalysisJob(pair: Pair, timeframe: Timeframe): AnalysisJob {
  const job: AnalysisJob = {
    id: randomUUID(),
    pair,
    timeframe,
    createdAt: Date.now(),
    stage: "market_data",
    stageStartedAt: Date.now(),
    status: "running",
    result: null,
  };
  jobs.set(job.id, job);
  pruneJobs();
  void runAnalysisJob(job).catch((err) => {
    job.status = "failed";
    job.failMessage = err instanceof Error ? err.message : "Unexpected error during analysis.";
    console.error(`[pairAnalysis] job ${job.id} (${pair} ${timeframe}) threw:`, err);
  });
  return job;
}

/**
 * Turns two real, independently-computed directional confidences (each 0-100, from
 * Signer A's own entry-tier scoring -- see confidenceScore.ts) into a genuine 3-way
 * BUY/SELL/NO-TRADE percentage split that always sums to exactly 100. The no-trade share
 * is simply "whatever's left" (100 minus both real scores, floored at 0 for the rare
 * case both sides independently scored high enough to exceed 100 combined -- a real,
 * if contradictory, outcome rather than an invented number); if that still doesn't sum
 * to 100 (the over-100 case), all three shares are proportionally rescaled so the total
 * is always exactly 100 without changing their relative weight. No number here is
 * invented -- the only new computation is this normalization arithmetic.
 */
export function normalizeDirectionalPercentages(rawBuy: number, rawSell: number): { buyPct: number; sellPct: number; noTradePct: number } {
  const rawNoTrade = Math.max(0, 100 - rawBuy - rawSell);
  const total = rawBuy + rawSell + rawNoTrade;
  if (total <= 0) return { buyPct: 0, sellPct: 0, noTradePct: 100 };
  return {
    buyPct: (rawBuy / total) * 100,
    sellPct: (rawSell / total) * 100,
    noTradePct: (rawNoTrade / total) * 100,
  };
}

function directionOf(evaluation: SignalEvaluation | null): "long" | "short" | "neutral" | "unavailable" {
  if (evaluation === null) return "unavailable";
  return evaluation.status === "signal" ? evaluation.signal.direction : "neutral";
}

async function runAnalysisJob(job: AnalysisJob): Promise<void> {
  const { pair, timeframe } = job;

  // --- market_data: read the same already-warm in-memory caches every other route
  // uses, plus a real freshness check that doesn't exist as a discrete gate today. ---
  const closedSeries = candleStore.get(pair, timeframe).slice(0, -1);
  const lastClosed = closedSeries[closedSeries.length - 1];
  if (!lastClosed) {
    job.status = "failed";
    job.failReason = "insufficient_data";
    job.failMessage = "No closed candles yet for this pair/timeframe -- try again shortly.";
    return;
  }
  const staleAfterMs = TIMEFRAME_MS[timeframe] * STALE_DATA_BAR_MULTIPLE;
  if (Date.now() - lastClosed.time > staleAfterMs) {
    job.status = "failed";
    job.failReason = "stale_data";
    job.failMessage = "Market data for this pair hasn't updated recently -- the live feed may be lagging.";
    return;
  }
  const higherTimeframes = {
    h1: candleStore.get(pair, "1h"),
    h4: candleStore.get(pair, "4h"),
    d1: candleStore.get(pair, "1d"),
  };
  const m15Series = candleStore.get(pair, "15m");
  const m30Series = candleStore.get(pair, "30m");
  const newsStatus = checkNews(pair, lastClosed.time);
  const regime = detectMarketRegime(closedSeries, calculateAdx(closedSeries), calculateAtr(closedSeries), newsStatus);
  job.result = { pair, timeframe, regime };
  await advanceStage(job, "structure");

  // --- structure: locate real bullish/bearish liquidity-sweep candidates (both sides,
  // not just whichever is most recent overall -- see findSweepCandidates). ---
  const shared = computeSharedGateContext(closedSeries, pair, timeframe, higherTimeframes);
  let bullish: SignalEvaluation | null = null;
  let bearish: SignalEvaluation | null = null;
  let sharedContext: SharedGateContext | null = null;
  if ("blocked" in shared) {
    // A direction-agnostic gate (too few candles -- already ruled out above by the
    // insufficient_data check, or outside the killzone) blocks BOTH sides identically;
    // still real, not fabricated -- the same reason either side would get standalone.
    bullish = { status: "no_trade", reason: shared.blocked };
    bearish = { status: "no_trade", reason: shared.blocked };
  } else {
    sharedContext = shared.context;
  }
  await advanceStage(job, "smc_engine");

  // --- smc_engine: score whichever real candidate(s) actually exist, independently. ---
  if (sharedContext) {
    const candidates = findSweepCandidates(sharedContext.recentSweeps);
    bullish = candidates.bullish ? evaluateDirectionalCandidate(sharedContext, candidates.bullish) : null;
    bearish = candidates.bearish ? evaluateDirectionalCandidate(sharedContext, candidates.bearish) : null;
  }
  Object.assign(job.result!, { bullish, bearish });
  await advanceStage(job, "range_engine");

  // --- range_engine: genuinely invoked here (unlike the plain /api/signals/evaluate
  // route, which never calls this) -- read-only/display-only, independent of
  // executionConfig.rangeEngineEnabled (that flag gates whether the LIVE/AUTO pipeline
  // can act on a range signal; showing its real verdict during a manual, non-executing
  // check is a different, safe concern -- see this file's own module doc). ---
  const rangeEvaluation = evaluateRangeSignal(closedSeries, pair, timeframe, { newsStatus });
  Object.assign(job.result!, { rangeEvaluation });
  await advanceStage(job, "multi_timeframe");

  // --- multi_timeframe: the same real emaTrendDirection() already used for h1/h4/d1,
  // genuinely applied to the pair's own 15m/30m series too -- a real 5-rung ladder. ---
  // Gap percentages (d1Gap/h4Gap/h1Gap) are only ever consumed by
  // positionRiskNarration.ts's "how close to flipping back" distance for an OPEN
  // position -- not needed here, so left null rather than computed and unused.
  const timeframeTrends: ExtendedTimeframeTrends = {
    m15: emaTrendDirection(m15Series),
    m30: emaTrendDirection(m30Series),
    h1: emaTrendDirection(higherTimeframes.h1),
    h4: emaTrendDirection(higherTimeframes.h4),
    d1: emaTrendDirection(higherTimeframes.d1),
    h1Gap: null,
    h4Gap: null,
    d1Gap: null,
  };
  Object.assign(job.result!, { timeframeTrends });
  await advanceStage(job, "consensus");

  // --- consensus: normalize the real per-direction confidences into a genuine 3-way
  // distribution, and assemble the real per-engine verdict breakdown. ---
  const rawBuy = bullish?.status === "signal" ? bullish.signal.confidence : 0;
  const rawSell = bearish?.status === "signal" ? bearish.signal.confidence : 0;
  const { buyPct, sellPct, noTradePct } = normalizeDirectionalPercentages(rawBuy, rawSell);

  // A genuine conflict is both sides independently qualifying -- an inherently
  // contradictory (rare) real state, surfaced honestly instead of silently picking
  // whichever scored higher.
  const conflicted = bullish?.status === "signal" && bearish?.status === "signal";
  const direction: "long" | "short" | "no_trade" = conflicted
    ? "no_trade"
    : bullish?.status === "signal"
      ? "long"
      : bearish?.status === "signal"
        ? "short"
        : "no_trade";

  // Signer B is genuinely direction-independent (it computes its own long/short/neutral
  // vote from EMA trend/Supertrend/RSI+divergence/currency strength, never told which
  // way to check -- see signerB.ts) -- but in the live/on-demand pipeline it only ever
  // runs once a candidate has already cleared the killzone gate (see
  // evaluateDirectionalCandidate), so "unavailable" here matches that same real
  // constraint rather than fabricating a reading the existing pipeline would never have
  // produced for a killzone-blocked pair.
  let signerBDirection: "long" | "short" | "neutral" | "unavailable" = "unavailable";
  if (sharedContext) {
    const rsiSeries = calculateRsi(closedSeries);
    const supertrendPoint = calculateSupertrend(closedSeries)[closedSeries.length - 1];
    const usdStrength = computeUsdStrength();
    const session = getActiveSession(lastClosed.time);
    const signerB = evaluateSignerB({ candles: closedSeries, pair, swings: sharedContext.swings, rsiSeries, supertrendPoint, usdStrength, session });
    signerBDirection = signerB.direction;
  }

  const engines: EngineVerdict[] = [
    { engine: "smc", direction: directionOf(bullish) === "long" ? "long" : directionOf(bearish) === "short" ? "short" : "neutral" },
    { engine: "signer_b", direction: signerBDirection },
    { engine: "range_engine", direction: directionOf(rangeEvaluation) },
    { engine: "timeframe_15m", direction: timeframeTrends.m15 === "neutral" ? "neutral" : timeframeTrends.m15 === "bullish" ? "long" : "short" },
    { engine: "timeframe_30m", direction: timeframeTrends.m30 === "neutral" ? "neutral" : timeframeTrends.m30 === "bullish" ? "long" : "short" },
    { engine: "timeframe_1h", direction: timeframeTrends.h1 === "neutral" ? "neutral" : timeframeTrends.h1 === "bullish" ? "long" : "short" },
    { engine: "timeframe_4h", direction: timeframeTrends.h4 === "neutral" ? "neutral" : timeframeTrends.h4 === "bullish" ? "long" : "short" },
    { engine: "timeframe_1d", direction: timeframeTrends.d1 === "neutral" ? "neutral" : timeframeTrends.d1 === "bullish" ? "long" : "short" },
  ];
  // The live-updating BUY/SELL/NO-TRADE readout the client shows DURING analysis (not
  // just at the final result) becomes real and readable from this point on -- every
  // field here is already fully computed, just attached to the job now instead of only
  // at the very end.
  Object.assign(job.result!, { buyPct, sellPct, noTradePct, conflicted: Boolean(conflicted), direction, engines });
  await advanceStage(job, "risk_validation");

  // --- risk_validation: the same currently-execute-only checks (riskManager.ts/
  // executionPolicy.ts), run early and read-only for transparency -- never places an
  // order, and are re-checked for real at actual execute time regardless (price/spread/
  // positions can all change in between). Only meaningful when a direction qualified. ---
  let riskValidation: PairAnalysisResult["riskValidation"] = null;
  if (direction !== "no_trade") {
    const winning = direction === "long" ? bullish : bearish;
    if (winning?.status === "signal") {
      const { signal } = winning;
      const accountKey = manualExecutionAccount(getEngineMode());
      const config = loadExecutionConfig(accountKey);
      const price = priceStore.get(pair);
      const openPositions = getOpenPositions(accountKey).map((p) => ({ pair: p.pair, direction: p.direction }));

      const spreadCheck = checkSpread({
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        currentBid: price?.bid,
        currentAsk: price?.ask,
        maxSpreadFractionOfStop: config.maxSpreadFractionOfStop,
      });
      const driftCheck = checkPriceDrift({
        direction: signal.direction,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        currentBid: price?.bid,
        currentAsk: price?.ask,
      });
      const correlationCheck = checkCorrelatedExposure({
        pair: signal.pair,
        direction: signal.direction,
        openPositions,
        maxCorrelatedPositions: config.maxCorrelatedPositions,
      });
      // Run without a calibration bucket -- this is an early, read-only preview before
      // "Place Trade" is ever tapped; the real execute call re-checks execution policy
      // (with full calibration) from scratch regardless, same as every other field here.
      const policyCheck = checkExecutionPolicy({ tier: signal.tier, riskReward: signal.riskReward, source: signal.source }, getExecutionPolicy());

      riskValidation = {
        spread: { allowed: spreadCheck.allowed, reason: spreadCheck.allowed ? undefined : spreadCheck.reason },
        priceDrift: { allowed: driftCheck.allowed, reason: driftCheck.allowed ? undefined : driftCheck.reason },
        correlatedExposure: { allowed: correlationCheck.allowed, reason: correlationCheck.allowed ? undefined : correlationCheck.reason },
        executionPolicy: { allowed: policyCheck.allowed, reason: policyCheck.allowed ? undefined : policyCheck.reason },
      };
    }
  }
  Object.assign(job.result!, { time: Date.now(), riskValidation });
  await advanceStage(job, "final");

  job.status = "complete";
}
