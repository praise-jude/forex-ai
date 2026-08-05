import type { Candle } from "../../types";

export function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, tickVolume: 100 };
}
