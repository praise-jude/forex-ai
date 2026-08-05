import type { Candle, LiquiditySweep, SwingPoint } from "../types";

/**
 * A liquidity sweep (stop hunt) is a wick that pierces a prior swing point
 * without the candle closing beyond it — price grabbed the resting stops and
 * snapped back. `priceTolerance` widens the swept level for equal-highs/lows
 * clusters instead of a single exact price.
 */
export function detectLiquiditySweeps(
  candles: Candle[],
  swings: SwingPoint[],
  priceTolerance = 0
): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];

  for (const swing of swings) {
    for (let j = swing.index + 1; j < candles.length; j++) {
      const candle = candles[j];
      if (swing.type === "high") {
        if (candle.high > swing.price + priceTolerance && candle.close < swing.price) {
          sweeps.push({ sweptSwing: swing, sweepIndex: j, side: "buyside" });
          break;
        }
      } else {
        if (candle.low < swing.price - priceTolerance && candle.close > swing.price) {
          sweeps.push({ sweptSwing: swing, sweepIndex: j, side: "sellside" });
          break;
        }
      }
    }
  }

  return sweeps;
}
