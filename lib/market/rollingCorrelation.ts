import { candleStore } from "./candleStore";
import { PAIRS, type Pair } from "./types";
import { isCorrelated as isStaticallyCorrelated } from "./pairCorrelation";

// 30 daily closes is a standard, defensible window for a rolling FX correlation --
// long enough to smooth out single-day noise, short enough to still reflect the
// current regime (correlations between majors genuinely drift month to month). A
// documented starting point to tune, not a claimed-optimal figure, same posture as
// every other weighted/tuned constant in this codebase (e.g. setupQualityScore.ts's
// dimension weights).
const CORRELATION_WINDOW_DAYS = 30;
// Below this many paired daily observations, a correlation coefficient is noise, not
// signal -- reported as "no data" (excluded from the matrix) rather than a
// misleadingly-precise number from a handful of days.
const MIN_PAIRED_OBSERVATIONS = 15;
// |correlation| at or above this counts as "strongly correlated" for the risk gate --
// a common real-world FX threshold, not a statistically derived cutoff. Below it, two
// pairs are treated as genuinely diversified even if not perfectly independent.
export const CORRELATION_THRESHOLD = 0.7;
// Correlation is a slow-moving statistical property (it only meaningfully shifts as
// new daily candles close), but this recompute is pure local computation over data
// already in memory -- microseconds of CPU, no external API cost -- so there's no
// reason to space it out the way currencyStrength.ts's paid-API poll is. Kept fairly
// frequent instead so a fresh boot/redeploy (where candleStore's D1 history is still
// being seeded concurrently with connect(), see metaApiConnection.ts) only has to wait
// up to an hour for real data, not the 6+ hours a "correlation barely changes"-only
// cadence would imply.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface CorrelationEntry {
  pairA: Pair;
  pairB: Pair;
  correlation: number;
  sampleSize: number;
}

interface CacheState {
  matrix: Map<string, CorrelationEntry>;
  computedAt: number | null;
  started: boolean;
}

const globalKey = Symbol.for("forex-ai.rollingCorrelation");
type GlobalWithCache = typeof globalThis & { [globalKey]?: CacheState };
const g = globalThis as GlobalWithCache;
const state: CacheState = g[globalKey] ?? (g[globalKey] = { matrix: new Map(), computedAt: null, started: false });

function pairKey(a: Pair, b: Pair): string {
  return [a, b].sort().join("|");
}

/** Daily % returns for `pair`, keyed by that D1 candle's own open time -- keying (not
 * just an ordered array) is what lets two pairs' return series be aligned by the same
 * calendar day below, rather than assuming both arrays advance in lockstep. */
function dailyReturnsByTime(pair: Pair): Map<number, number> {
  const candles = candleStore.get(pair, "1d").slice(-(CORRELATION_WINDOW_DAYS + 1));
  const returns = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    if (prevClose === 0) continue;
    returns.set(candles[i].time, (candles[i].close - prevClose) / prevClose);
  }
  return returns;
}

/** Standard Pearson correlation coefficient. Null (not 0) when there isn't enough
 * paired data or either series has zero variance -- an honest "can't compute this",
 * never a fabricated "no correlation". */
function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < MIN_PAIRED_OBSERVATIONS) return null;

  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) return null;

  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * Recomputes the full pairwise correlation matrix from candleStore's own D1 history --
 * called periodically (see startRollingCorrelation below), never per risk check, since
 * this is O(pairs^2) work and correlation itself doesn't need per-trade freshness.
 * candleStore already has this data (seeded at boot, kept live by the streaming
 * connection for chart display) -- no new data fetch, purely local computation.
 */
export function recomputeCorrelationMatrix(): void {
  const returnsByPair = new Map<Pair, Map<number, number>>();
  for (const pair of PAIRS) returnsByPair.set(pair, dailyReturnsByTime(pair));

  const next = new Map<string, CorrelationEntry>();
  for (let i = 0; i < PAIRS.length; i++) {
    for (let j = i + 1; j < PAIRS.length; j++) {
      const pairA = PAIRS[i];
      const pairB = PAIRS[j];
      const returnsA = returnsByPair.get(pairA)!;
      const returnsB = returnsByPair.get(pairB)!;

      const alignedA: number[] = [];
      const alignedB: number[] = [];
      for (const [time, returnA] of returnsA) {
        const returnB = returnsB.get(time);
        if (returnB !== undefined) {
          alignedA.push(returnA);
          alignedB.push(returnB);
        }
      }

      const correlation = pearson(alignedA, alignedB);
      if (correlation !== null) {
        next.set(pairKey(pairA, pairB), { pairA, pairB, correlation, sampleSize: alignedA.length });
      }
    }
  }

  state.matrix = next;
  state.computedAt = Date.now();
}

export function startRollingCorrelation(): void {
  if (state.started) return;
  state.started = true;
  recomputeCorrelationMatrix();
  setInterval(recomputeCorrelationMatrix, REFRESH_INTERVAL_MS);
}

export function getCorrelation(pairA: Pair, pairB: Pair): CorrelationEntry | null {
  if (pairA === pairB) return null;
  return state.matrix.get(pairKey(pairA, pairB)) ?? null;
}

/** Every computed entry, most-correlated-first by magnitude -- the "what's actually
 * correlated right now" view for the diagnostics UI. */
export function listCorrelations(): CorrelationEntry[] {
  return Array.from(state.matrix.values()).sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

export function correlationMatrixAge(): number | null {
  return state.computedAt === null ? null : Date.now() - state.computedAt;
}

/**
 * Union of the real rolling correlation (when available) and the original static USD-
 * direction/commodity-complex grouping (pairCorrelation.ts) -- deliberately never
 * subtracts from the static model's own conservative floor, only adds cases real data
 * catches that the static model misses (e.g. gold vs. a specific FX major correlating
 * during a particular macro regime, which the static model has no concept of). This is
 * what checkCorrelatedExposure in riskManager.ts actually calls; a bug here can only
 * make execution MORE conservative, matching that function's own existing invariant.
 *
 * Sign matters: two pairs with POSITIVE correlation move together, so the same
 * direction (both long, or both short) is the compounding bet; two pairs with NEGATIVE
 * correlation move oppositely, so OPPOSITE directions are the compounding bet (a long
 * on one and a short on the other is really the same underlying view). Below
 * CORRELATION_THRESHOLD in magnitude, the pairs are treated as genuinely diversified.
 */
export function isCorrelated(pairA: Pair, directionA: "long" | "short", pairB: Pair, directionB: "long" | "short"): boolean {
  if (isStaticallyCorrelated(pairA, directionA, pairB, directionB)) return true;

  const entry = getCorrelation(pairA, pairB);
  if (!entry) return false;

  if (entry.correlation >= CORRELATION_THRESHOLD) return directionA === directionB;
  if (entry.correlation <= -CORRELATION_THRESHOLD) return directionA !== directionB;
  return false;
}
