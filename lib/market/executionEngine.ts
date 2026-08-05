import { createHash, randomUUID } from "node:crypto";
import type { Signal } from "./types";
import { eventBus } from "./eventBus";
import { positionStore } from "./positionStore";
import { riskState } from "./riskState";
import { checkRiskLimits, isKillSwitchActive } from "./riskManager";
import { loadExecutionConfig } from "./executionConfig";
import { computeLotSize } from "./positionSizing";
import { getAccountInformation, getOpenPositionCount, getSymbolSpecification, placeMarketOrder } from "./metaApiConnection";

// MT5's comment+clientId combined length cap is ~26-31 chars, so the raw signal.id
// (a 36-char UUID) doesn't fit — use a short hash instead, as defense-in-depth
// alongside the primary app-side idempotency guard below.
function shortClientId(signalId: string): string {
  return createHash("sha1").update(signalId).digest("hex").slice(0, 16);
}

/**
 * Attempts to execute a single signal: risk checks -> position sizing -> order
 * placement -> ledger recording. Safe to call more than once for the same signal —
 * every call after the first is a no-op via the idempotency guard below.
 */
export async function attemptExecution(signal: Signal): Promise<void> {
  // Primary idempotency guard. Must run synchronously, before the first `await` in
  // this function, so it's race-free against a duplicate signal event arriving while
  // an earlier attempt for the same signal is still in flight.
  if (positionStore.hasExecuted(signal.id)) return;

  const now = Date.now();
  const config = loadExecutionConfig();

  const account = getAccountInformation();
  if (!account) {
    console.error(`[execution] skip ${signal.pair} ${signal.id}: no account information available yet`);
    return;
  }

  const dayState = riskState.current(now, account.equity);
  const riskCheck = checkRiskLimits({
    killSwitchActive: isKillSwitchActive(config.killSwitchFile),
    haltedForToday: dayState.haltedForToday,
    openPositionCount: getOpenPositionCount(),
    maxConcurrentPositions: config.maxConcurrentPositions,
    tradesOpenedToday: dayState.tradesOpenedToday,
    maxTradesPerDay: config.maxTradesPerDay,
    startOfDayEquity: dayState.startOfDayEquity,
    currentEquity: account.equity,
    maxDailyLossPct: config.maxDailyLossPct,
  });

  if (!riskCheck.allowed) {
    console.log(`[execution] skip ${signal.pair} ${signal.id}: ${riskCheck.reason}`);
    if (riskCheck.code === "daily_loss") riskState.setHaltedForToday(now, account.equity);
    return;
  }

  const spec = getSymbolSpecification(signal.pair);
  if (!spec) {
    console.error(`[execution] skip ${signal.pair} ${signal.id}: no symbol specification available yet`);
    return;
  }

  const sizing = computeLotSize(signal, account.equity, config.riskPerTradePct, spec);
  if ("skipped" in sizing) {
    console.log(`[execution] skip ${signal.pair} ${signal.id}: ${sizing.reason}`);
    return;
  }

  // Reserve the signal id before the broker call — everything above this point is
  // read-only and safe to repeat, but from here on a duplicate call must not re-fire.
  positionStore.recordAttempt({
    id: randomUUID(),
    signalId: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    requestedLots: sizing.lots,
    requestedEntry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskPct: config.riskPerTradePct,
    attemptedAt: now,
  });

  const result = await placeMarketOrder(
    signal.pair,
    signal.direction,
    sizing.lots,
    signal.stopLoss,
    signal.takeProfit,
    signal.entry,
    shortClientId(signal.id)
  );

  if (!result.success) {
    positionStore.markRejected(signal.id, result.message);
    console.error(`[execution] rejected ${signal.pair} ${signal.id}: ${result.message}`, {
      numericCode: result.numericCode,
      stringCode: result.stringCode,
      lots: sizing.lots,
    });
    return;
  }

  positionStore.markFilled(signal.id, {
    filledEntry: result.filledEntry,
    brokerPositionId: result.brokerPositionId,
    brokerOrderId: result.brokerOrderId,
    filledAt: Date.now(),
  });
  riskState.recordTradeOpened(now, account.equity);
  console.log(
    `[execution] filled ${signal.direction} ${sizing.lots} lots ${signal.pair} @ ${result.filledEntry} (signal ${signal.id})`
  );
}

let started = false;

/**
 * Subscribes to the same event bus the SSE route reads from, rather than being called
 * directly from metaApiConnection.ts — keeps that file unaware the execution engine
 * exists at all, avoiding an import cycle (executionEngine needs metaApiConnection's
 * broker accessors). Node's EventEmitter invokes listeners synchronously within the
 * same call stack as `publish()`, so execution still starts in the same tick a signal
 * is published — this isn't a meaningfully looser ordering guarantee than a direct call.
 */
export function startExecutionEngine(): void {
  if (started) return;
  started = true;

  eventBus.subscribe((event) => {
    if (event.type !== "signal") return;
    attemptExecution(event.signal).catch((error: unknown) => {
      console.error(`[execution] unhandled error attempting signal ${event.signal.id}:`, error);
    });
  });
}
