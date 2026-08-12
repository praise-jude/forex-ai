import type { ExecutedTrade, Signal } from "./types";
import { eventBus } from "./eventBus";
import { positionStore } from "./positionStore";
import { closePosition } from "./metaApiConnection";
import { mark as markInvalidation } from "./invalidationMarker";

/**
 * Pure matching logic: which currently-open trades does this fresh signal invalidate?
 * Same pair AND timeframe (three signal engines run concurrently per pair, see
 * metaApiConnection.ts's own SIGNAL_TIMEFRAMES) and the OPPOSITE direction -- across
 * both accounts, since a live position and a demo position can both be open on the same
 * pair/timeframe independently. The caller is responsible for only ever passing an
 * `source === "smc"` signal here (see startPositionInvalidation) -- this function
 * doesn't re-check that, since it operates purely on already-filtered inputs.
 */
export function findInvalidatedTrades(signal: Signal, openTrades: ExecutedTrade[]): ExecutedTrade[] {
  const oppositeDirection = signal.direction === "long" ? "short" : "long";
  return openTrades.filter(
    (trade) =>
      trade.status === "filled" &&
      trade.brokerPositionId !== undefined &&
      trade.pair === signal.pair &&
      trade.timeframe === signal.timeframe &&
      trade.direction === oppositeDirection
  );
}

let started = false;

/**
 * The early-exit half of position management (see positionManager.ts for the price-
 * based break-even/trailing half). Reuses the exact same two-signers-must-agree bar as
 * entry itself -- only a fresh, fully-qualified opposite-direction Signal closes a
 * position, never a partial/ambiguous read. Deliberately excludes TradingView-sourced
 * signals (source !== "smc"), which never went through Signer B confirmation at all --
 * reusing autoExecutionListener.ts's own identical guard, for the identical reason.
 */
export function startPositionInvalidation(): void {
  if (started) return;
  started = true;

  eventBus.subscribe((event) => {
    if (event.type !== "signal" || event.signal.source !== "smc") return;

    const openTrades = positionStore.all().filter((t) => t.status === "filled");
    const invalidated = findInvalidatedTrades(event.signal, openTrades);

    for (const trade of invalidated) {
      const brokerPositionId = trade.brokerPositionId;
      if (!brokerPositionId) continue;

      closePosition(brokerPositionId, trade.account)
        .then((result) => {
          if (result.success) {
            // Marked only AFTER a confirmed-successful close -- a failed or raced
            // close attempt must never mislabel a later, genuinely SL/TP-triggered
            // close as an invalidation exit.
            markInvalidation(brokerPositionId);
            console.log(`[position-invalidation] closed ${trade.pair} (${brokerPositionId}, ${trade.account}) -- opposite signal fired`);
          } else {
            console.error(`[position-invalidation] close failed for ${trade.pair} (${brokerPositionId}, ${trade.account}): ${result.message}`);
          }
        })
        .catch((error: unknown) => {
          console.error(`[position-invalidation] error closing ${trade.pair} (${brokerPositionId}, ${trade.account}):`, error);
        });
    }
  });
}
