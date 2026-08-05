import type { Candle, StructureEvent, StructureEventType, SwingPoint } from "../types";

/**
 * Walks candles chronologically, tracking the most recent unbroken swing high/low.
 * A close beyond the opposing swing is a structure break: continuation of the current
 * trend is a Break of Structure (BOS), a break against the current trend is a
 * Market Structure Shift (MSS/reversal). Requires `swings` sorted ascending by index
 * (the order detectSwingPoints already produces).
 */
export function detectStructureBreaks(candles: Candle[], swings: SwingPoint[]): StructureEvent[] {
  const events: StructureEvent[] = [];
  let trend: "bullish" | "bearish" | null = null;
  let lastSwingHigh: SwingPoint | null = null;
  let lastSwingLow: SwingPoint | null = null;
  let swingCursor = 0;

  for (let i = 0; i < candles.length; i++) {
    while (swingCursor < swings.length && swings[swingCursor].index <= i) {
      const swing = swings[swingCursor];
      if (swing.type === "high") lastSwingHigh = swing;
      else lastSwingLow = swing;
      swingCursor++;
    }

    const candle = candles[i];

    if (lastSwingHigh && i > lastSwingHigh.index && candle.close > lastSwingHigh.price) {
      const type: StructureEventType = trend === "bearish" ? "MSS_BULLISH" : "BOS_BULLISH";
      events.push({ type, brokenSwing: lastSwingHigh, breakIndex: i, time: candle.time });
      trend = "bullish";
      lastSwingHigh = null;
    } else if (lastSwingLow && i > lastSwingLow.index && candle.close < lastSwingLow.price) {
      const type: StructureEventType = trend === "bullish" ? "MSS_BEARISH" : "BOS_BEARISH";
      events.push({ type, brokenSwing: lastSwingLow, breakIndex: i, time: candle.time });
      trend = "bearish";
      lastSwingLow = null;
    }
  }

  return events;
}
