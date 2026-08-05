import type { Pair } from "./types";
import { decimals } from "./symbols";

export function formatPrice(pair: Pair, value: number): string {
  return value.toFixed(decimals(pair));
}
