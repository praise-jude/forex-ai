import type { Candle, FairValueGap } from "../types";

/**
 * Classic 3-candle imbalance: a bullish gap forms when candle[i-1]'s high sits
 * below candle[i+1]'s low (candle[i] traded straight through without overlap),
 * and the mirror image for bearish gaps.
 */
export function detectFairValueGaps(candles: Candle[]): FairValueGap[] {
  const gaps: FairValueGap[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (prev.high < next.low) {
      gaps.push({ direction: "bullish", startIndex: i - 1, top: next.low, bottom: prev.high, filled: false });
    } else if (prev.low > next.high) {
      gaps.push({ direction: "bearish", startIndex: i - 1, top: prev.low, bottom: next.high, filled: false });
    }
  }

  for (const gap of gaps) {
    const formedThroughIndex = gap.startIndex + 2;
    for (let j = formedThroughIndex + 1; j < candles.length; j++) {
      const candle = candles[j];
      if (gap.direction === "bullish" && candle.low <= gap.bottom) {
        gap.filled = true;
        break;
      }
      if (gap.direction === "bearish" && candle.high >= gap.top) {
        gap.filled = true;
        break;
      }
    }
  }

  return gaps;
}
