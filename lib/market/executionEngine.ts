import { createHash, randomUUID } from "node:crypto";
import type { AccountKey, ExecutedTrade, Signal } from "./types";
import { positionStore } from "./positionStore";
import { priceStore } from "./priceStore";
import { riskState } from "./riskState";
import { checkPriceDrift, checkRiskLimits, isKillSwitchActive, type RiskBlockCode } from "./riskManager";
import { loadExecutionConfig } from "./executionConfig";
import { computeLotSize } from "./positionSizing";
import {
  getAccountInformation,
  getOpenPositionCount,
  getSymbolSpecification,
  isAccountConfigured,
  placeMarketOrder,
} from "./metaApiConnection";

// MT5's comment+clientId combined length cap is ~26-31 chars, so the raw signal.id
// (a 36-char UUID) doesn't fit — use a short hash instead, as defense-in-depth
// alongside the primary app-side idempotency guard below.
function shortClientId(signalId: string): string {
  return createHash("sha1").update(signalId).digest("hex").slice(0, 16);
}

export type ExecutionResult =
  | { status: "duplicate" }
  | { status: "blocked"; code: RiskBlockCode | "no_account" | "no_symbol_spec" | "watch_tier"; reason: string }
  | { status: "skipped_sizing"; reason: string }
  | { status: "filled"; trade: ExecutedTrade }
  | { status: "rejected"; trade: ExecutedTrade };

/**
 * Attempts to execute a single signal against the given account: risk checks -> position
 * sizing -> order placement -> ledger recording. Safe to call more than once for the same
 * signal+account pair — every call after the first returns "duplicate" via the
 * idempotency guard below, without re-hitting the broker. Called from the manual Buy/Sell
 * confirmation route, the TradingView webhook (always "live"), and the auto-execution
 * listener for DEMO/LIVE engine mode.
 */
export async function attemptExecution(signal: Signal, accountKey: AccountKey = "live"): Promise<ExecutionResult> {
  // Primary idempotency guard. Must run synchronously, before the first `await` in
  // this function, so it's race-free against a duplicate click (or two browser tabs)
  // arriving while an earlier attempt for the same signal is still in flight.
  if (positionStore.hasExecuted(signal.id, accountKey)) return { status: "duplicate" };

  // Watch-tier signals are shown on the dashboard for information only — they never
  // cleared the buy/strong_buy confidence bar, so there's deliberately no button for
  // them client-side. This is the server-side backstop in case that's ever bypassed.
  if (signal.tier === "watch") {
    return { status: "blocked", code: "watch_tier", reason: "watch-tier signals are informational only and cannot be executed" };
  }

  const now = Date.now();
  const config = loadExecutionConfig(accountKey);

  const account = getAccountInformation(accountKey);
  if (!account) {
    const reason =
      accountKey === "demo" && !isAccountConfigured("demo")
        ? "demo account is not configured (missing METAAPI_DEMO_TOKEN/METAAPI_DEMO_ACCOUNT_ID)"
        : "no account information available yet";
    console.error(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${reason}`);
    return { status: "blocked", code: "no_account", reason };
  }

  const dayState = riskState.current(now, account.equity, accountKey);
  const riskCheck = checkRiskLimits({
    killSwitchActive: isKillSwitchActive(config.killSwitchFile),
    haltedForToday: dayState.haltedForToday,
    now,
    cooldownUntil: dayState.cooldownUntil,
    openPositionCount: getOpenPositionCount(accountKey),
    maxConcurrentPositions: config.maxConcurrentPositions,
    tradesOpenedToday: dayState.tradesOpenedToday,
    maxTradesPerDay: config.maxTradesPerDay,
    startOfDayEquity: dayState.startOfDayEquity,
    currentEquity: account.equity,
    maxDailyLossPct: config.maxDailyLossPct,
  });

  if (!riskCheck.allowed) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${riskCheck.reason}`);
    if (riskCheck.code === "daily_loss") riskState.setHaltedForToday(now, account.equity, accountKey);
    return { status: "blocked", code: riskCheck.code, reason: riskCheck.reason };
  }

  // Applies to every execution path (button and voice alike), not just voice -- but
  // matters most there, since a spoken confirmation round trip leaves more time for the
  // price to drift from the signal's entry than an immediate button click does.
  const currentPrice = priceStore.get(signal.pair);
  const priceDriftCheck = checkPriceDrift({
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    currentBid: currentPrice?.bid,
    currentAsk: currentPrice?.ask,
  });
  if (!priceDriftCheck.allowed) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${priceDriftCheck.reason}`);
    return { status: "blocked", code: priceDriftCheck.code, reason: priceDriftCheck.reason };
  }

  const spec = getSymbolSpecification(signal.pair, accountKey);
  if (!spec) {
    console.error(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): no symbol specification available yet`);
    return { status: "blocked", code: "no_symbol_spec", reason: "no symbol specification available yet" };
  }

  const sizing = computeLotSize(signal, account.equity, config.riskPerTradePct, spec);
  if ("skipped" in sizing) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${sizing.reason}`);
    return { status: "skipped_sizing", reason: sizing.reason };
  }

  // Reserve the signal id before the broker call — everything above this point is
  // read-only and safe to repeat, but from here on a duplicate call must not re-fire.
  const record = positionStore.recordAttempt({
    id: randomUUID(),
    signalId: signal.id,
    account: accountKey,
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
    shortClientId(signal.id),
    accountKey
  );

  if (!result.success) {
    positionStore.markRejected(signal.id, result.message, accountKey);
    console.error(`[execution] rejected ${signal.pair} ${signal.id} (${accountKey}): ${result.message}`, {
      numericCode: result.numericCode,
      stringCode: result.stringCode,
      lots: sizing.lots,
    });
    return { status: "rejected", trade: { ...record, status: "rejected", rejectReason: result.message } };
  }

  const filledAt = Date.now();
  positionStore.markFilled(
    signal.id,
    {
      filledEntry: result.filledEntry,
      brokerPositionId: result.brokerPositionId,
      brokerOrderId: result.brokerOrderId,
      filledAt,
    },
    accountKey
  );
  riskState.recordTradeOpened(now, account.equity, accountKey);
  console.log(
    `[execution] filled ${signal.direction} ${sizing.lots} lots ${signal.pair} @ ${result.filledEntry} (signal ${signal.id}, ${accountKey})`
  );
  return {
    status: "filled",
    trade: {
      ...record,
      status: "filled",
      filledEntry: result.filledEntry,
      brokerPositionId: result.brokerPositionId,
      brokerOrderId: result.brokerOrderId,
      filledAt,
    },
  };
}
