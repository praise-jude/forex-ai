import { describe, expect, it } from "vitest";
import { candle } from "../detectors/__tests__/fixtures";
import { assembleSignals } from "../signalEngine";
import { calculateAtr } from "../indicators/atr";
import type { Candle } from "../types";

// Sellside liquidity sweep -> BOS_BULLISH (breaks a swing high) -> a further push to a
// new swing high + a higher swing low (for Market Structure) -> pullback dipping into
// the bullish FVG left behind by the original impulsive move, tagging it for the
// first time on the final (killzone-hour) candle. Prefixed with 230 warm-up candles so
// the EMA200-based checks (trend agreement, EMA stack) have enough history. Built and
// verified empirically (debug-script-and-iterate) the same way the original signal
// fixture was, given how many interacting detectors/indicators this now exercises.
const WARMUP_LENGTH = 230;
const PATTERN_START_PRICE = 1.0;
const WARMUP_START_PRICE = 0.8;

const START = Date.UTC(2024, 1, 1, 8, 0, 0) - (WARMUP_LENGTH + 20) * 15 * 60 * 1000;
const t = (i: number) => START + i * 15 * 60 * 1000;

function buildWarmup(direction: "up" | "down" = "up"): Candle[] {
  const magnitude = (PATTERN_START_PRICE - WARMUP_START_PRICE - 0.05) / WARMUP_LENGTH;
  const step = direction === "up" ? magnitude : -magnitude;
  const startPrice = direction === "up" ? WARMUP_START_PRICE : PATTERN_START_PRICE + 0.2;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < WARMUP_LENGTH; i++) {
    const open = price;
    price += step;
    const close = price;
    const high = Math.max(open, close) + 0.00005;
    const low = Math.min(open, close) - 0.00005;
    candles.push({ time: t(i), open, high, low, close, tickVolume: 100 });
  }
  return candles;
}

function buildPattern(offset: number, strongFinalCandle = true): Candle[] {
  // Bullish, small body, long lower wick (pin bar) when strong; a plain-bodied candle
  // (no candlestick match, ~5 points lower) otherwise — used by the score-threshold test.
  const finalCandle = strongFinalCandle
    ? { ...candle(t(offset + 20), 1.055, 1.059, 1.027, 1.058), tickVolume: 500 }
    : { ...candle(t(offset + 20), 1.03, 1.041, 1.027, 1.038), tickVolume: 500 };

  return [
    candle(t(offset + 0), 1.0, 1.005, 0.995, 1.002),
    candle(t(offset + 1), 1.002, 1.01, 1.0, 1.006),
    candle(t(offset + 2), 1.006, 1.008, 0.985, 0.99), // swing low @ 0.985
    candle(t(offset + 3), 0.99, 1.006, 0.995, 1.0),
    candle(t(offset + 4), 1.0, 1.012, 0.998, 1.008),
    candle(t(offset + 5), 1.008, 1.015, 1.005, 1.012), // swing high @ 1.015
    candle(t(offset + 6), 1.012, 1.014, 1.004, 1.01),
    candle(t(offset + 7), 1.01, 1.011, 0.978, 1.005), // sellside sweep of the 0.985 low
    candle(t(offset + 8), 1.005, 1.014, 1.0, 1.012),
    candle(t(offset + 9), 1.012, 1.014, 1.008, 1.01),
    candle(t(offset + 10), 1.01, 1.033, 1.005, 1.032), // closes above 1.015 -> BOS_BULLISH
    candle(t(offset + 11), 1.032, 1.035, 1.028, 1.033),
    candle(t(offset + 12), 1.033, 1.036, 1.03, 1.034),
    candle(t(offset + 13), 1.034, 1.035, 1.032, 1.033), // mild dip, stays well above the FVG
    candle(t(offset + 14), 1.033, 1.036, 1.032, 1.035),
    candle(t(offset + 15), 1.035, 1.038, 1.034, 1.037),
    candle(t(offset + 16), 1.037, 1.05, 1.036, 1.048), // new swing high ~1.050 (Market Structure)
    candle(t(offset + 17), 1.048, 1.049, 1.029, 1.045), // pullback, stays just above the FVG top (1.028)
    // gap below the FVG entirely (high < 1.014): a clean new swing low ~1.012, higher than
    // the original 0.978 sweep low (Market Structure), close stays < 1.015 without its high
    // ever reaching 1.015 so this doesn't register as a false sweep of the 1.015 swing high
    candle(t(offset + 18), 1.0135, 1.0139, 1.012, 1.0138),
    candle(t(offset + 19), 1.033, 1.05, 1.032, 1.049), // gap back above the FVG entirely
    // final retest candle: dips into the FVG (low 1.027, well above the 1.012 swing low so it
    // doesn't sweep it) and closes strong, not a pullback from the prior close, to keep MACD's
    // fast line above its signal line
    finalCandle,
  ];
}

function buildHigherTf(length: number, direction: "up" | "down"): Candle[] {
  const step = direction === "up" ? 0.002 : -0.002;
  const candles: Candle[] = [];
  let price = direction === "up" ? 0.9 : 1.1;
  for (let i = 0; i < length; i++) {
    const open = price;
    price += step;
    const close = price;
    candles.push({
      time: i,
      open,
      high: Math.max(open, close) + 0.0005,
      low: Math.min(open, close) - 0.0005,
      close,
      tickVolume: 100,
    });
  }
  return candles;
}

function buildCandles(options: { warmup?: "up" | "down"; strongFinalCandle?: boolean } = {}): Candle[] {
  return [...buildWarmup(options.warmup ?? "up"), ...buildPattern(WARMUP_LENGTH, options.strongFinalCandle ?? true)];
}

function buildHigherTimeframes(direction: "up" | "down" = "up") {
  return { h1: buildHigherTf(210, direction), h4: buildHigherTf(210, direction), d1: buildHigherTf(210, direction) };
}

describe("assembleSignals", () => {
  it("produces a long signal when SMC, multi-timeframe trend, and the weighted score all line up in a killzone", () => {
    const signals = assembleSignals(buildCandles(), "EUR/USD", "15m", buildHigherTimeframes("up"));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      pair: "EUR/USD",
      direction: "long",
      timeframe: "15m",
      session: "london",
      tier: "buy",
      confidence: 90,
    });
    expect(signals[0].confluences).toEqual(
      expect.arrayContaining([
        "liquidity_sweep",
        "bos",
        "fvg",
        "killzone",
        "multi_timeframe",
        "trend_ema_stack",
        "adx",
        "market_structure",
        "volume",
        "macd_crossover",
        "rsi_momentum",
        "candlestick",
      ])
    );
    expect(signals[0].stopLoss).toBeLessThan(signals[0].entry);
    expect(signals[0].takeProfit).toBeGreaterThan(signals[0].entry);
    expect(signals[0].takeProfit2).toBeGreaterThan(signals[0].takeProfit);
    expect(signals[0].riskReward).toBeGreaterThanOrEqual(1.5);
  });

  it("places the SL buffer proportional to the instrument's own ATR, not a fixed pip amount", () => {
    const candles = buildCandles();
    const signals = assembleSignals(candles, "EUR/USD", "15m", buildHigherTimeframes("up"));
    expect(signals).toHaveLength(1);

    const sweptSwingPrice = 0.985; // the sellside sweep's swing low, per buildPattern's comments
    const buffer = sweptSwingPrice - signals[0].stopLoss; // stopLoss sits below the swept low for a long
    const atr = calculateAtr(candles)[candles.length - 1];

    expect(buffer).toBeGreaterThan(0);
    // Meaningfully larger than the old flat 3-pip EUR/USD buffer (0.0003) would have given,
    // and never the whole ATR -- loose bounds since the exact fraction is a tunable constant.
    expect(buffer).toBeGreaterThan(0.0003 * 5);
    expect(buffer).toBeLessThan(atr);
  });

  it("does not fire outside a killzone even with the same setup", () => {
    const candles = buildCandles();
    const offSession = new Date(candles[candles.length - 1].time);
    offSession.setUTCHours(18); // well outside London/NY killzones
    candles[candles.length - 1] = { ...candles[candles.length - 1], time: offSession.getTime() };

    expect(assembleSignals(candles, "EUR/USD", "15m", buildHigherTimeframes("up"))).toEqual([]);
  });

  it("does not re-fire once price has already tagged the zone", () => {
    const candles = buildCandles();
    // One more candle that also dips back into the FVG -- only the first tap (already
    // covered by the passing test above) should ever produce a signal.
    candles.push(candle(t(WARMUP_LENGTH + 21), 1.04, 1.045, 1.02, 1.035));

    expect(assembleSignals(candles, "EUR/USD", "15m", buildHigherTimeframes("up"))).toEqual([]);
  });

  it("suppresses an otherwise-valid signal when D1 and H4 trend disagree", () => {
    const higherTimeframes = { ...buildHigherTimeframes("up"), h4: buildHigherTf(210, "down") };
    expect(assembleSignals(buildCandles(), "EUR/USD", "15m", higherTimeframes)).toEqual([]);
  });

  it("downgrades to a watch-tier signal when volume confirmation is missing", () => {
    // Same pattern that scores 90 ("buy") in the first test, but the final candle's
    // volume is dropped below the 20-candle average -- an isolated, single-category
    // change (tickVolume doesn't affect price-based checks like MACD/RSI/candlestick),
    // costing exactly the 10-point volume weight: 90 - 10 = 80, landing right at the
    // "watch" floor rather than clearing the 90% "buy" threshold.
    const candles = buildCandles({ strongFinalCandle: true });
    const finalCandle = candles[candles.length - 1];
    candles[candles.length - 1] = { ...finalCandle, tickVolume: 1 };
    const signals = assembleSignals(candles, "EUR/USD", "15m", buildHigherTimeframes("up"));
    expect(signals).toHaveLength(1);
    expect(signals[0].tier).toBe("watch");
    expect(signals[0].confidence).toBe(80);
  });

  it("suppresses a signal entirely when the confidence score falls below the watch threshold", () => {
    // The plain-bodied final candle (no candlestick match) closes meaningfully lower
    // than the "strong" version, which flips MACD agreement too, not just the
    // candlestick check -- dropping the score from 90 to 75, below even the "watch"
    // floor, so nothing fires at all.
    const candles = buildCandles({ strongFinalCandle: false });
    expect(assembleSignals(candles, "EUR/USD", "15m", buildHigherTimeframes("up"))).toEqual([]);
  });
});
