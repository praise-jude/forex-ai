import type { Candle, Pair, Session, SwingPoint } from "./types";
import type { SupertrendPoint } from "./indicators/supertrend";
import { emaTrendDirection } from "./indicators/emaTrend";
import { detectRsiDivergence } from "./indicators/rsiDivergence";
import { usdStrengthSupports, type UsdStrength } from "./currencyStrength";
import { tierOf, type DimensionTier } from "./confidenceScore";

const RSI_DIRECTION_LOOKBACK = 3;
const RSI_FLAT_DEADBAND = 2; // RSI points -- a move smaller than this isn't a real rising/falling read

const EMA_WEIGHT = 35;
const SUPERTREND_WEIGHT = 25;
const RSI_WEIGHT = 20;
const CURRENCY_STRENGTH_WEIGHT = 20;

export type SignerBDirection = "long" | "short" | "neutral";
type RsiZone = "overbought" | "oversold" | "healthy" | "unavailable";
type RsiDirectionReading = "rising" | "falling" | "flat" | "unavailable";

export interface SignerBFactors {
  emaTrend: "bullish" | "bearish" | "neutral";
  rsiZone: RsiZone;
  rsiDirection: RsiDirectionReading;
  rsiDivergence: "bullish" | "bearish" | null;
  supertrend: "up" | "down" | "unavailable";
  currencyStrength: "long" | "short" | "neutral" | "unavailable";
  /** Display-only -- by the time this runs, evaluateSignal's own hard pre-gates have
   * already required an active killzone (FX pairs) and above-average ATR, so these
   * can't meaningfully vary here. Scoring a constant would be fake precision; shown on
   * the card anyway since the user's dashboard mockup expects to see them. */
  volatility: "healthy";
  session: Session;
}

export interface SignerBResult {
  direction: SignerBDirection;
  /** 0-100. Only meaningful when direction !== "neutral" -- a "neutral" tie can still
   * carry nonzero confidence (see evaluateSignerB's own comment); decisionMatrix.ts
   * gates purely on `direction`, never on this number, when direction is neutral. */
  confidence: number;
  tier: DimensionTier;
  factors: SignerBFactors;
}

type Vote = "long" | "short" | "neutral" | "unavailable";

function rsiZoneOf(rsi: number): "overbought" | "oversold" | "healthy" {
  if (rsi > 70) return "overbought";
  if (rsi < 30) return "oversold";
  return "healthy";
}

function rsiDirectionOf(rsiSeries: number[], lastIndex: number): RsiDirectionReading {
  const refIndex = lastIndex - RSI_DIRECTION_LOOKBACK;
  if (refIndex < 0) return "unavailable";
  const latest = rsiSeries[lastIndex];
  const reference = rsiSeries[refIndex];
  if (Number.isNaN(latest) || Number.isNaN(reference)) return "unavailable";
  const delta = latest - reference;
  if (delta > RSI_FLAT_DEADBAND) return "rising";
  if (delta < -RSI_FLAT_DEADBAND) return "falling";
  return "flat";
}

/**
 * Deliberately not the naive `RSI > 50 = BUY`. A confirmed divergence (a reversal
 * tell) overrides the plain read; otherwise only "rising from a healthy zone" or
 * "falling from a healthy zone" cast a vote. An overbought/oversold reading with no
 * confirming divergence, or a flat reading inside the healthy zone, is real
 * information (not missing data) that just doesn't lean either way -- a `"neutral"`
 * vote, which dilutes confidence the same way a real currency-strength deadband does
 * (see evaluateCurrencyStrengthFactor). Only a genuinely unwarmed RSI (NaN) is
 * `"unavailable"` and excluded from the tally entirely.
 */
function evaluateRsiFactor(
  candles: Candle[],
  rsiSeries: number[],
  swings: SwingPoint[]
): { vote: Vote; zone: RsiZone; direction: RsiDirectionReading; divergence: "bullish" | "bearish" | null } {
  const lastIndex = candles.length - 1;
  const rsi = rsiSeries[lastIndex];
  if (Number.isNaN(rsi)) return { vote: "unavailable", zone: "unavailable", direction: "unavailable", divergence: null };

  const zone = rsiZoneOf(rsi);
  const direction = rsiDirectionOf(rsiSeries, lastIndex);
  const divergence = detectRsiDivergence(candles, rsiSeries, swings);

  if (divergence === "bullish") return { vote: "long", zone, direction, divergence };
  if (divergence === "bearish") return { vote: "short", zone, direction, divergence };
  if (zone === "healthy" && direction === "rising") return { vote: "long", zone, direction, divergence: null };
  if (zone === "healthy" && direction === "falling") return { vote: "short", zone, direction, divergence: null };
  return { vote: "neutral", zone, direction, divergence: null };
}

/** Reuses usdStrengthSupports (unchanged) against both possible directions to derive
 * an independent lean, rather than duplicating currencyStrength.ts's deadband logic
 * here. Both `false` (inside the deadband) is a real "neutral" vote, not missing data
 * -- only `usdStrength.status === "unavailable"` itself is excluded from the tally. */
function evaluateCurrencyStrengthFactor(usdStrength: UsdStrength, pair: Pair): { vote: Vote; display: "long" | "short" | "neutral" | "unavailable" } {
  const supportsLong = usdStrengthSupports(usdStrength, pair, "long");
  if (supportsLong === "unavailable") return { vote: "unavailable", display: "unavailable" };
  if (supportsLong === true) return { vote: "long", display: "long" };
  const supportsShort = usdStrengthSupports(usdStrength, pair, "short");
  if (supportsShort === true) return { vote: "short", display: "short" };
  return { vote: "neutral", display: "neutral" };
}

/**
 * Signer B: an independent read of Trend + Momentum + Volatility + Currency Strength
 * + Session -- computed WITHOUT reference to SMC's own direction (contrast with the
 * old confirmation dimension, which only asked "does this agree with SMC"). Weighted
 * vote across 4 directional factors, reusing the "unavailable excluded, rescaled to
 * what's knowable" pattern proven in confidenceScore.ts's old scoreConfirmation (moved
 * here) -- a data source that hasn't warmed up yet narrows what's being asked rather
 * than silently sinking the result. A genuine tie is always `"neutral"` -- Signer B
 * has no real opinion, which decisionMatrix.ts treats as a reason to WAIT, not as
 * "50/50 buy". Confidence is 0 only for the "nothing available" tie (0 vs 0, `possible
 * === 0`); a tie between two real nonzero-weight factors (e.g. RSI vs currency
 * strength, both 20) is confidence 50 -- still `"neutral"` direction, so it's still a
 * WAIT, just not reported as a fabricated 0% when real (conflicting) evidence exists.
 */
export function evaluateSignerB(input: {
  candles: Candle[];
  pair: Pair;
  swings: SwingPoint[];
  rsiSeries: number[];
  supertrendPoint: SupertrendPoint;
  usdStrength: UsdStrength;
  session: Session;
}): SignerBResult {
  const emaTrend = emaTrendDirection(input.candles);
  const emaVote: Vote = emaTrend === "bullish" ? "long" : emaTrend === "bearish" ? "short" : "unavailable";

  const supertrend = input.supertrendPoint.trend ?? "unavailable";
  const supertrendVote: Vote = supertrend === "up" ? "long" : supertrend === "down" ? "short" : "unavailable";

  const rsi = evaluateRsiFactor(input.candles, input.rsiSeries, input.swings);
  const currencyStrength = evaluateCurrencyStrengthFactor(input.usdStrength, input.pair);

  const votes: { vote: Vote; weight: number }[] = [
    { vote: emaVote, weight: EMA_WEIGHT },
    { vote: supertrendVote, weight: SUPERTREND_WEIGHT },
    { vote: rsi.vote, weight: RSI_WEIGHT },
    { vote: currencyStrength.vote, weight: CURRENCY_STRENGTH_WEIGHT },
  ];

  const available = votes.filter((v) => v.vote !== "unavailable");
  const possible = available.reduce((sum, v) => sum + v.weight, 0);
  const longScore = available.filter((v) => v.vote === "long").reduce((sum, v) => sum + v.weight, 0);
  const shortScore = available.filter((v) => v.vote === "short").reduce((sum, v) => sum + v.weight, 0);

  const direction: SignerBDirection = longScore > shortScore ? "long" : shortScore > longScore ? "short" : "neutral";
  const confidence = possible === 0 ? 0 : (Math.max(longScore, shortScore) / possible) * 100;

  return {
    direction,
    confidence,
    tier: tierOf(confidence),
    factors: {
      emaTrend,
      rsiZone: rsi.zone,
      rsiDirection: rsi.direction,
      rsiDivergence: rsi.divergence,
      supertrend,
      currencyStrength: currencyStrength.display,
      volatility: "healthy",
      session: input.session,
    },
  };
}
