import { beforeEach, describe, expect, it } from "vitest";
import { candleStore } from "../candleStore";
import {
  CORRELATION_THRESHOLD,
  correlationMatrixAge,
  correlationTier,
  getCorrelation,
  isCorrelated,
  listCorrelations,
  recomputeCorrelationMatrix,
} from "../rollingCorrelation";
import type { Candle, Pair } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A deterministic, varying (not monotonic) sequence of daily % returns -- varying so
 * a real Pearson correlation actually has something to distinguish, unlike a constant
 * return series (which has zero variance and correlates with nothing, see pearson()'s
 * own null-on-zero-variance case). */
function sampleReturns(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 0.01 * Math.sin(i * 0.7) + 0.002 * Math.cos(i * 1.3));
}

/** Builds closing prices from an explicit sequence of daily % returns via cumulative
 * product -- guarantees the resulting return series is exactly `returns`, unlike
 * deriving two price levels that merely trend in opposite directions (dividing by a
 * different, changing denominator on each side means "oppositely trending price"
 * does NOT imply "oppositely signed returns", which cost a first draft of this test
 * a false negative-correlation assumption). */
function closesFromReturns(startPrice: number, returns: number[]): number[] {
  const closes = [startPrice];
  for (const r of returns) closes.push(closes[closes.length - 1] * (1 + r));
  return closes;
}

/** Builds a D1 candle series from a list of closes, one per day, starting at a fixed
 * epoch so two series can be aligned by identical `time` values. */
function seedDaily(pair: Pair, closes: number[]): void {
  const candles: Candle[] = closes.map((close, i) => ({
    time: i * DAY_MS,
    open: close,
    high: close,
    low: close,
    close,
    tickVolume: 1,
  }));
  candleStore.seed(pair, "1d", candles);
}

const ALL_PAIRS: Pair[] = ["EUR/USD", "GBP/USD", "USD/CAD", "USD/JPY", "AUD/USD", "XAU/USD", "XAG/USD", "USOIL", "UKOIL", "BTC/USD"];

function clearAllCandles(): void {
  for (const pair of ALL_PAIRS) candleStore.seed(pair, "1d", []);
}

describe("recomputeCorrelationMatrix / getCorrelation", () => {
  beforeEach(clearAllCandles);

  it("reports a near-perfect positive correlation for two series with identical returns", () => {
    const returns = sampleReturns(20);
    seedDaily("EUR/USD", closesFromReturns(1, returns));
    seedDaily("GBP/USD", closesFromReturns(1, returns));

    recomputeCorrelationMatrix();
    const entry = getCorrelation("EUR/USD", "GBP/USD");
    expect(entry).not.toBeNull();
    expect(entry!.correlation).toBeGreaterThan(0.99);
    expect(entry!.sampleSize).toBeGreaterThanOrEqual(15);
  });

  it("reports a near-perfect negative correlation for two series with exactly negated returns", () => {
    const returns = sampleReturns(20);
    seedDaily("EUR/USD", closesFromReturns(1, returns));
    seedDaily("USD/CAD", closesFromReturns(1, returns.map((r) => -r)));

    recomputeCorrelationMatrix();
    const entry = getCorrelation("EUR/USD", "USD/CAD");
    expect(entry!.correlation).toBeLessThan(-0.99);
  });

  it("returns null (not zero) below the minimum sample size, an honest 'no data' rather than a fabricated number", () => {
    const returns = sampleReturns(3);
    seedDaily("EUR/USD", closesFromReturns(1, returns));
    seedDaily("GBP/USD", closesFromReturns(1, returns));

    recomputeCorrelationMatrix();
    expect(getCorrelation("EUR/USD", "GBP/USD")).toBeNull();
  });

  it("returns null for a pair against itself", () => {
    seedDaily("EUR/USD", closesFromReturns(1, sampleReturns(20)));
    recomputeCorrelationMatrix();
    expect(getCorrelation("EUR/USD", "EUR/USD")).toBeNull();
  });

  it("returns null when a series has zero variance (a flat price series has nothing to correlate)", () => {
    seedDaily("EUR/USD", closesFromReturns(1, sampleReturns(20)));
    seedDaily("GBP/USD", Array.from({ length: 21 }, () => 1)); // perfectly flat -- zero variance
    recomputeCorrelationMatrix();
    expect(getCorrelation("EUR/USD", "GBP/USD")).toBeNull();
  });

  it("lists computed entries sorted by correlation magnitude, most-correlated-first", () => {
    const returns = sampleReturns(20);
    seedDaily("EUR/USD", closesFromReturns(1, returns));
    seedDaily("GBP/USD", closesFromReturns(1, returns)); // matches EUR/USD exactly
    seedDaily("USD/CAD", closesFromReturns(1, sampleReturns(20).reverse())); // unrelated shape

    recomputeCorrelationMatrix();
    const entries = listCorrelations();
    expect(entries.length).toBeGreaterThan(0);
    const top = entries[0];
    expect(Math.abs(top.correlation)).toBeGreaterThanOrEqual(Math.abs(entries[entries.length - 1].correlation));
  });

  it("tracks when the matrix was last computed", () => {
    recomputeCorrelationMatrix();
    expect(correlationMatrixAge()).not.toBeNull();
    expect(correlationMatrixAge()).toBeLessThan(1000);
  });
});

describe("isCorrelated", () => {
  beforeEach(() => {
    clearAllCandles();
    recomputeCorrelationMatrix();
  });

  it("still catches the original static grouping even with no real correlation data (falls back honestly)", () => {
    // EUR/USD long + GBP/USD long is a known static-model correlated pair (both a
    // short-USD bet) -- must still be caught even though no D1 data was seeded for it.
    expect(isCorrelated("EUR/USD", "long", "GBP/USD", "long")).toBe(true);
  });

  it("never flags a pair the static model says is uncorrelated when real data is unavailable", () => {
    expect(isCorrelated("BTC/USD", "long", "XAU/USD", "long")).toBe(false);
  });

  it("catches a real correlation the static model has no concept of, same direction on positive correlation", () => {
    const returns = sampleReturns(20);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, returns)); // static model has no correlation partner for BTC/USD at all
    recomputeCorrelationMatrix();

    expect(isCorrelated("XAU/USD", "long", "BTC/USD", "long")).toBe(true);
    expect(isCorrelated("XAU/USD", "long", "BTC/USD", "short")).toBe(false); // opposite side is a hedge, not a stacked bet
  });

  it("catches a real negative correlation as correlated only on OPPOSITE directions", () => {
    const returns = sampleReturns(20);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, returns.map((r) => -r)));
    recomputeCorrelationMatrix();

    expect(isCorrelated("XAU/USD", "long", "BTC/USD", "short")).toBe(true);
    expect(isCorrelated("XAU/USD", "long", "BTC/USD", "long")).toBe(false);
  });

  it("does not flag two pairs whose real correlation is below the threshold", () => {
    const returns = sampleReturns(20);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, sampleReturns(20).reverse()));
    recomputeCorrelationMatrix();

    const entry = getCorrelation("XAU/USD", "BTC/USD");
    if (entry) expect(Math.abs(entry.correlation)).toBeLessThan(CORRELATION_THRESHOLD);
    expect(isCorrelated("XAU/USD", "long", "BTC/USD", "long")).toBe(false);
  });
});

describe("correlationTier", () => {
  beforeEach(() => {
    clearAllCandles();
    recomputeCorrelationMatrix();
  });

  // XAU/USD and BTC/USD have no static-model correlation partner with each other at all
  // (see pairCorrelation.ts) -- a clean pair to exercise the real-correlation-only tiers
  // without the static grouping's own always-extreme floor interfering.
  const independent = (n: number) => Array.from({ length: n }, (_, i) => 0.01 * Math.sin(i * 2.9) + 0.003 * Math.cos(i * 0.4));
  function blend(a: number[], b: number[], weight: number): number[] {
    return a.map((v, i) => weight * v + (1 - weight) * b[i]);
  }

  it("is 'none' below the base threshold, even on a compounding direction", () => {
    const returns = sampleReturns(60);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, blend(returns, independent(60), 0.3))); // ~0.38 real correlation
    recomputeCorrelationMatrix();

    expect(correlationTier("XAU/USD", "long", "BTC/USD", "long")).toBe("none");
  });

  it("is 'moderate' in the 0.70-0.79 band", () => {
    const returns = sampleReturns(60);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, blend(returns, independent(60), 0.55))); // ~0.76 real correlation
    recomputeCorrelationMatrix();

    const entry = getCorrelation("XAU/USD", "BTC/USD")!;
    expect(entry.correlation).toBeGreaterThanOrEqual(0.7);
    expect(entry.correlation).toBeLessThan(0.8);
    expect(correlationTier("XAU/USD", "long", "BTC/USD", "long")).toBe("moderate");
  });

  it("is 'strong' in the 0.80-0.89 band", () => {
    const returns = sampleReturns(60);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, blend(returns, independent(60), 0.65))); // ~0.85 real correlation (compounded through price levels)
    recomputeCorrelationMatrix();

    const entry = getCorrelation("XAU/USD", "BTC/USD")!;
    expect(entry.correlation).toBeGreaterThanOrEqual(0.8);
    expect(entry.correlation).toBeLessThan(0.9);
    expect(correlationTier("XAU/USD", "long", "BTC/USD", "long")).toBe("strong");
  });

  it("is 'extreme' at 0.90+ real correlation, same as a static-model match", () => {
    const returns = sampleReturns(60);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, blend(returns, independent(60), 0.75))); // ~0.94 real correlation
    recomputeCorrelationMatrix();

    const entry = getCorrelation("XAU/USD", "BTC/USD")!;
    expect(entry.correlation).toBeGreaterThanOrEqual(0.9);
    expect(correlationTier("XAU/USD", "long", "BTC/USD", "long")).toBe("extreme");
  });

  it("a static-model match is always 'extreme', even with zero real data", () => {
    expect(correlationTier("EUR/USD", "long", "GBP/USD", "long")).toBe("extreme");
  });

  it("the opposite direction on a positive real correlation is a hedge, not a compounding bet -- 'none'", () => {
    const returns = sampleReturns(60);
    seedDaily("XAU/USD", closesFromReturns(1, returns));
    seedDaily("BTC/USD", closesFromReturns(1, blend(returns, independent(60), 0.75))); // ~0.94 real correlation
    recomputeCorrelationMatrix();

    expect(correlationTier("XAU/USD", "long", "BTC/USD", "short")).toBe("none");
  });
});
