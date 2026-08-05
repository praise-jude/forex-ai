import type { Pair } from "./types";
import { pipSize } from "./symbols";
import { priceStore } from "./priceStore";

// USD is the base currency (first symbol) for these pairs, so pip value needs
// converting from the quote currency into USD via the pair's own live price.
// The other pairs already quote directly in USD, so no conversion is needed.
const USD_BASE_PAIRS: ReadonlySet<Pair> = new Set(["USD/JPY", "USD/CAD"]);

/**
 * Pip value in USD per 1.0 lot, for a USD-denominated account. Returns
 * undefined when a conversion rate is needed but no live price is available yet.
 */
export function pipValuePerLot(pair: Pair, contractSize: number): number | undefined {
  const quotePipValue = pipSize(pair) * contractSize;
  if (!USD_BASE_PAIRS.has(pair)) return quotePipValue;

  const price = priceStore.get(pair);
  if (!price) return undefined;
  const mid = (price.bid + price.ask) / 2;
  return quotePipValue / mid;
}
