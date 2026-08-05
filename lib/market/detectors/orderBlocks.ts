import type { Candle, OrderBlock, StructureEvent } from "../types";

/**
 * The order block for a structure break is the last opposite-colored candle
 * before the impulsive move that produced the break — the last footprint of
 * the losing side before price ran the other way.
 */
export function detectOrderBlocks(candles: Candle[], structureEvents: StructureEvent[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];

  for (const event of structureEvents) {
    const bullish = event.type === "BOS_BULLISH" || event.type === "MSS_BULLISH";
    let obIndex = -1;

    for (let j = event.breakIndex - 1; j >= 0; j--) {
      const candle = candles[j];
      const isOpposite = bullish ? candle.close < candle.open : candle.close > candle.open;
      if (isOpposite) {
        obIndex = j;
        break;
      }
    }
    if (obIndex === -1) continue;

    const ob = candles[obIndex];
    const top = Math.max(ob.open, ob.close);
    const bottom = Math.min(ob.open, ob.close);

    let mitigated = false;
    for (let j = event.breakIndex + 1; j < candles.length; j++) {
      const candle = candles[j];
      if (candle.low <= top && candle.high >= bottom) {
        mitigated = true;
        break;
      }
    }

    blocks.push({ direction: bullish ? "bullish" : "bearish", index: obIndex, top, bottom, mitigated });
  }

  return blocks;
}
