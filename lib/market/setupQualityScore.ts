import type { MarketRegime, Signal } from "./types";

const SMC_MAX = 30;
const TREND_MAX = 20;
const MOMENTUM_MAX = 15;
const LIQUIDITY_MAX = 10;
const VOLATILITY_MAX = 10;
const NEWS_MAX = 10;
const SESSION_MAX = 5;

// A regime that doesn't confirm the signal's own direction (e.g. the setup is long but
// the broader read is "range", not "strong_uptrend") shaves a small, fixed amount off
// the trend sub-score rather than a fabricated multiplier -- documented default to
// observe and tune, not a claimed-optimal figure, same posture as every other weighted
// score in this codebase.
const TREND_REGIME_MISMATCH_PENALTY = 2;

export interface SetupQualityBreakdown {
  smc: number; // 0-30
  trend: number; // 0-20
  momentum: number; // 0-15
  liquidity: number; // 0-10
  volatility: number; // 0-10
  newsRisk: number; // 0-10
  session: number; // 0-5
  /** Sum of the above -- always 0-100 by construction. Explicitly NOT a probability of
   * winning (see confidenceScore.ts/signerB.ts's own repeated framing) -- a transparent
   * breakdown of how well-confirmed the setup is, using only data the engine already
   * computed. Nothing here is invented: every sub-score traces to a real Signal field
   * or the independently-computed market regime. */
  total: number;
}

/**
 * Not stored on `Signal` -- computed on demand from fields the Signal already carries
 * (directionScore, entryScore, confluences, newsStatus, session) plus the independently
 * computed MarketRegime, so there's nothing new to keep in sync and no schema change.
 * Weights are documented defaults, not claimed-optimal figures.
 */
export function scoreSetupQuality(signal: Signal, regime: MarketRegime): SetupQualityBreakdown {
  // SMC (Signer A's entry-trigger quality: zone type, candlestick, MACD, RSI, volume).
  const smc = Math.round((signal.entryScore / 100) * SMC_MAX);

  // Trend (Signer A's own direction/structure quality), nudged down if the
  // independently-computed regime doesn't itself read as a strong trend in the same
  // direction -- two different reads of "is this really trending" agreeing matters.
  const regimeAgrees =
    (signal.direction === "long" && regime === "strong_uptrend") || (signal.direction === "short" && regime === "strong_downtrend");
  const trendBase = Math.round((signal.directionScore / 100) * TREND_MAX);
  const trend = Math.max(0, regimeAgrees ? trendBase : trendBase - TREND_REGIME_MISMATCH_PENALTY);

  // Momentum: real confluence tags already on the signal (RSI momentum, MACD crossover,
  // RSI divergence) -- never re-derived from raw indicator values here.
  let momentum = 0;
  if (signal.confluences.includes("rsi_momentum")) momentum += 5;
  if (signal.confluences.includes("macd_crossover")) momentum += 5;
  if (signal.confluences.includes("rsi_divergence")) momentum += 5;
  momentum = Math.min(momentum, MOMENTUM_MAX);

  // Liquidity: every real SMC signal already requires a liquidity sweep plus a
  // confirming structure break (signalEngine.ts's own hard gates -- "no_setup"
  // otherwise) -- always full marks for a signal that exists at all. Shown for
  // transparency about what was required to get here, not because it discriminates
  // between setups (it structurally can't -- every fired signal already cleared this).
  const hasSweepAndStructure = signal.confluences.includes("liquidity_sweep") && (signal.confluences.includes("bos") || signal.confluences.includes("choch"));
  const liquidity = hasSweepAndStructure ? LIQUIDITY_MAX : 0;

  // Volatility: the low-volatility hard gate already guarantees real movement for any
  // fired signal -- this reflects how much, via the same independently-computed regime
  // shown elsewhere on the card, not a new ATR computation duplicating that gate.
  const volatility = regime === "high_volatility" ? VOLATILITY_MAX : regime === "low_volatility" ? 3 : 7;

  // News risk: newsStatus can never be "high_impact_soon" on a fired signal (that's a
  // hard blackout gate, see signalEngine.ts) -- only "clear" or "unavailable" ever
  // reach here, and "unavailable" is scored as an honest neutral, not a penalty.
  const newsRisk = signal.newsStatus === "clear" ? NEWS_MAX : signal.newsStatus === "unavailable" ? 5 : 0;

  // Session: full marks in the London/New York killzone (required for every non-crypto
  // signal); crypto is killzone-exempt (see isCrypto in signalEngine.ts) and can fire
  // in Asia or off-session hours, scored lower to reflect the thinner liquidity typical
  // of those hours -- not a claim those hours are unsafe, just less institutionally active.
  const session = signal.session === "london" || signal.session === "newyork" ? SESSION_MAX : signal.session === "asia" ? 3 : 2;

  const total = smc + trend + momentum + liquidity + volatility + newsRisk + session;

  return { smc, trend, momentum, liquidity, volatility, newsRisk, session, total };
}
