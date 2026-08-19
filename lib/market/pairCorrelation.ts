import type { Pair } from "./types";

/**
 * A small STATIC grouping, not a rolling correlation coefficient -- same pragmatic-
 * simplification style as currencyStrength.ts's own aggregate USD index (a real
 * correlation matrix would need historical price data and constant recalculation for
 * marginal accuracy gain). This exists to catch the obvious case the README already
 * flagged as a known gap: opening EUR/USD long and GBP/USD long back to back isn't two
 * diversified bets, it's one USD-short bet taken twice.
 *
 * Forex majors are grouped by their IMPLIED USD DIRECTION: for a USD-quote pair (EUR/USD,
 * GBP/USD, AUD/USD) going long means going short USD; for a USD-base pair (USD/CAD,
 * USD/JPY) going long means going long USD. Two majors share exposure when their implied
 * USD direction matches. Precious metals and oil are grouped by pure commodity-complex
 * membership (XAU/USD and XAG/USD move together far more from "gold complex" sentiment
 * than from any USD-quote-currency logic; same for USOIL/UKOIL) -- direction still has
 * to match (two longs, or two shorts, not one of each) for them to count as correlated.
 * BTC/USD has no correlation partner in this simplified model.
 */

type ImpliedUsdRole = "usd_quote" | "usd_base";

const FOREX_MAJOR_ROLE: Partial<Record<Pair, ImpliedUsdRole>> = {
  "EUR/USD": "usd_quote",
  "GBP/USD": "usd_quote",
  "AUD/USD": "usd_quote",
  "NZD/USD": "usd_quote",
  "USD/CAD": "usd_base",
  "USD/JPY": "usd_base",
  "USD/CHF": "usd_base",
  // EUR/JPY has no USD leg at all -- deliberately absent from this USD-only static
  // model, not an oversight. Its real correlation with EUR/USD and USD/JPY is still
  // caught by rollingCorrelation.ts's own live Pearson correlation matrix (computed
  // across every pair in PAIRS, this static grouping is only ever a floor on top of
  // it) -- see that file's own doc comment on the union between the two.
};

const COMMODITY_GROUP: Partial<Record<Pair, string>> = {
  "XAU/USD": "precious_metals",
  "XAG/USD": "precious_metals",
  USOIL: "oil",
  UKOIL: "oil",
};

/** Direction of a forex major's implied bet on USD itself -- "long_usd" means the
 * position profits if USD strengthens, regardless of which side of the pair that is. */
function impliedUsdDirection(pair: Pair, direction: "long" | "short"): "long_usd" | "short_usd" | null {
  const role = FOREX_MAJOR_ROLE[pair];
  if (!role) return null;
  const longsUsd = role === "usd_base" ? direction === "long" : direction === "short";
  return longsUsd ? "long_usd" : "short_usd";
}

/**
 * True when two positions represent the same directional bet in this simplified model.
 * A pair is never correlated with itself here in the sense that matters for the guard --
 * callers are expected to compare the incoming signal's pair against OTHER already-open
 * positions, not itself (see checkCorrelatedExposure in riskManager.ts).
 */
export function isCorrelated(pairA: Pair, directionA: "long" | "short", pairB: Pair, directionB: "long" | "short"): boolean {
  const usdA = impliedUsdDirection(pairA, directionA);
  const usdB = impliedUsdDirection(pairB, directionB);
  if (usdA && usdB) return usdA === usdB;

  const groupA = COMMODITY_GROUP[pairA];
  const groupB = COMMODITY_GROUP[pairB];
  if (groupA && groupB) return groupA === groupB && directionA === directionB;

  return false;
}
