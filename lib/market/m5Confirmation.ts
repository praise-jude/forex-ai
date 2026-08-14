import type { Candle } from "./types";

// Just needs the most recently closed bar -- a small buffer in case the API's most
// recent entry is still the forming candle depending on exact close-alignment timing,
// same defensive sizing reasoning as seedHistory.ts's own HISTORY_BARS, just far smaller
// since this only ever needs the latest close, not a real history.
export const M5_CONFIRMATION_BARS = 3;

/**
 * Pure -- confirms the most recently closed M5 candle closed in the signal's own
 * direction (a bullish close for a long setup, bearish for a short). This is a
 * voluntarily-added quality gate on top of everything signalEngine.ts already checks,
 * not a pre-existing risk control, so empty/insufficient data reads as NOT confirmed
 * (fail closed) -- a fetch hiccup at decision time should hold the trade rather than
 * silently skip the one check it exists to make. See metaApiConnection.ts's
 * fetchRecentCandles for why this is an on-demand REST call, not a live subscription.
 */
export function confirmsDirection(m5Candles: Candle[], direction: "long" | "short"): boolean {
  if (m5Candles.length === 0) return false;
  const last = m5Candles[m5Candles.length - 1];
  return direction === "long" ? last.close > last.open : last.close < last.open;
}
