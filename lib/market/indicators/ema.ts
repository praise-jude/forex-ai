/**
 * Exponential moving average over a plain number series (not Candle[]) so it can be
 * reused on prices (close) or on a derived series (e.g. the MACD line itself).
 * SMA-seeded over the first `period` values; entries before that are NaN rather than
 * a misleadingly-early partial average.
 */
export function calculateEma(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return result;

  const seed = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  result[period - 1] = seed;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1];
  }

  return result;
}
