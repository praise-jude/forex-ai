import type { Candle } from "../types";
import { calculateEma } from "./ema";

// A fixed 200-candle warmup was found to be permanently unmet on D1: this account's
// MetaApi-served D1 history runs sparser than a real market calendar (~0.48
// candles/day observed across every pair, not the ~0.71 a weekdays-only calendar
// would give), so even a full 2-year fetch topped out at 154-350 D1 candles
// depending on pair -- never 200. That silently forced signalEngine.ts's D1/H4/H1
// trend-agreement gate to read "neutral" on literally every candle, for every pair,
// permanently -- not a real trend disagreement, just an unmeetable warmup floor
// blocking every setup (confirmed via backtest: 100% of trend_disagreement rejections
// had d1 === "neutral"). 20/50 keeps the same "faster EMA vs slower EMA" trend read
// at a warmup this account's real D1 (and H4, for the shorter-history symbols) data
// can actually clear, while H1 and the primary timeframe already had far more than
// enough candles either way.
const FAST_PERIOD = 20;
const SLOW_PERIOD = 50;

/**
 * EMA20/EMA50 relationship on whatever candle array is passed in -- shared by
 * signalEngine.ts's D1/H4/H1 multi-timeframe agreement pre-gate (unchanged call site)
 * and signerB.ts's own-timeframe independent trend read. Distinct from the stricter
 * 4-EMA stack scored in confidenceScore.ts's direction dimension -- that's SMC's own
 * internal trend-quality check, this is a plain two-line read reused wherever "what
 * does the fast/slow EMA say" is asked.
 */
export function emaTrendDirection(candles: Candle[]): "bullish" | "bearish" | "neutral" {
  if (candles.length < SLOW_PERIOD) return "neutral";
  const closes = candles.map((c) => c.close);
  const index = candles.length - 1;
  const fast = calculateEma(closes, FAST_PERIOD)[index];
  const slow = calculateEma(closes, SLOW_PERIOD)[index];
  if (Number.isNaN(fast) || Number.isNaN(slow)) return "neutral";
  if (fast > slow) return "bullish";
  if (fast < slow) return "bearish";
  return "neutral";
}

/**
 * How far apart the same EMA20/EMA50 read from emaTrendDirection above currently sit,
 * as a signed percentage of the slow EMA (positive = bullish gap, negative = bearish
 * gap). Deliberately separate from emaTrendDirection rather than folded into it -- that
 * function's exact return shape is depended on by signalEngine.ts's hard gate and
 * signerB.ts, both of which have no use for the gap; adding it here only serves the one
 * caller that does (positionRiskNarration.ts's "how close is the opposing timeframe to
 * flipping back" distance, see its own doc comment). A smaller magnitude means the fast
 * and slow EMA are closer to crossing -- this is a real, CURRENT distance, never a time
 * estimate for when it'll actually cross, which this app doesn't fabricate anywhere.
 */
export function emaTrendGapPct(candles: Candle[]): number | null {
  if (candles.length < SLOW_PERIOD) return null;
  const closes = candles.map((c) => c.close);
  const index = candles.length - 1;
  const fast = calculateEma(closes, FAST_PERIOD)[index];
  const slow = calculateEma(closes, SLOW_PERIOD)[index];
  if (Number.isNaN(fast) || Number.isNaN(slow) || slow === 0) return null;
  return ((fast - slow) / slow) * 100;
}
