import type { Candle } from "../types";
import { trueRange } from "./atr";

function dxFromSmoothed(smoothedPlusDM: number, smoothedMinusDM: number, smoothedTR: number): number {
  if (smoothedTR === 0) return 0;
  const plusDI = (100 * smoothedPlusDM) / smoothedTR;
  const minusDI = (100 * smoothedMinusDM) / smoothedTR;
  const sum = plusDI + minusDI;
  return sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
}

/**
 * Standard Wilder ADX: +DM/-DM/TR are Wilder-smoothed into +DI/-DI, which combine into
 * DX, which is itself Wilder-smoothed into ADX. Needs 2*period candles before the
 * first value (period for the DI smoothing, another period for the ADX smoothing of
 * DX) — entries before that are NaN.
 */
export function calculateAdx(candles: Candle[], period = 14): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period * 2) return result;

  const plusDM = new Array<number>(candles.length).fill(0);
  const minusDM = new Array<number>(candles.length).fill(0);
  const tr = new Array<number>(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = trueRange(candles, i);
  }

  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;
  let smoothedTR = 0;
  for (let i = 1; i <= period; i++) {
    smoothedPlusDM += plusDM[i];
    smoothedMinusDM += minusDM[i];
    smoothedTR += tr[i];
  }

  const dx = new Array<number>(candles.length).fill(NaN);
  dx[period] = dxFromSmoothed(smoothedPlusDM, smoothedMinusDM, smoothedTR);

  for (let i = period + 1; i < candles.length; i++) {
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];
    smoothedTR = smoothedTR - smoothedTR / period + tr[i];
    dx[i] = dxFromSmoothed(smoothedPlusDM, smoothedMinusDM, smoothedTR);
  }

  const adxSeedEnd = period + period - 1;
  let adx = 0;
  for (let i = period; i <= adxSeedEnd; i++) adx += dx[i];
  adx /= period;
  result[adxSeedEnd] = adx;

  for (let i = adxSeedEnd + 1; i < candles.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    result[i] = adx;
  }

  return result;
}
