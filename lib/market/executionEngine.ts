import { randomUUID } from "node:crypto";
import type { AccountKey, ExecutedTrade, Signal } from "./types";
import { positionStore } from "./positionStore";
import { priceStore } from "./priceStore";
import { riskState } from "./riskState";
import { checkCorrelatedExposure, checkPriceDrift, checkRiskLimits, checkSpread, isKillSwitchActive, type RiskBlockCode } from "./riskManager";
import { checkExecutionPolicy, getExecutionPolicy, type ExecutionPolicyBlockCode } from "./executionPolicy";
import { loadExecutionConfig } from "./executionConfig";
import { computeLotSize, confidenceAdjustedRiskPct, confluenceAdjustedMultiplier, roundToTick } from "./positionSizing";
import { tradeJournal, getConfidenceCalibration, getConfluenceBreakdown, defaultCalibrationMinSamples } from "./tradeJournal";
import { deEscalationSizeMultiplier } from "./deEscalation";
import { engineSizeMultiplier, sessionSizeMultiplier } from "./adaptiveEdge";
import {
  getAccountInformation,
  getOpenPositionCount,
  getOpenPositions,
  getSymbolSpecification,
  isAccountConfigured,
  placeMarketOrder,
} from "./metaApiConnection";
import { sendNotification } from "./pushNotifier";
import { sendWebhookNotification } from "./webhookNotifier";
import { formatPrice } from "./format";

export type ExecutionResult =
  | { status: "duplicate" }
  | { status: "blocked"; code: RiskBlockCode | "no_account" | "no_symbol_spec" | "watch_tier" | ExecutionPolicyBlockCode; reason: string }
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
 *
 * `riskPctOverride` is the dashboard proposal card's one-off "Edit Risk" control --
 * computeLotSize already takes risk% as a plain argument, so this is the entire feature:
 * fall back to the account's configured riskPerTradePct when omitted (every caller
 * except the manual-execute route's own "Edit Risk" field omits it).
 */
export async function attemptExecution(signal: Signal, accountKey: AccountKey = "live", riskPctOverride?: number): Promise<ExecutionResult> {
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

  const config = loadExecutionConfig(accountKey);
  const manualOverride = config.unrestrictedManualTrading && signal.source === "manual";

  // Checked unconditionally, even under manualOverride -- every other check below can be
  // relaxed by UNRESTRICTED_MANUAL_TRADING (an operator's explicit "let my own reviewed
  // clicks through the account-level circuit breakers" request), but the kill switch is
  // the operator's own physical "STOP LIVE" tap. That button's copy makes an unqualified
  // promise: no new orders. A manual trade still slipping through while it reads
  // "active" would silently break that promise for the one control an operator reaches
  // for specifically to guarantee nothing fires, regardless of source.
  if (isKillSwitchActive(config.killSwitchFile)) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): kill switch is active`);
    return { status: "blocked", code: "kill_switch", reason: "kill switch is active" };
  }

  // Operator-configured selectivity floor, on top of the signal's own already-computed
  // tier/riskReward -- never changes how a signal was scored or how its TP was picked
  // (see executionPolicy.ts). Exempts TradingView-sourced signals internally. Calibration
  // is only computed when the policy's own calibratedGateEnabled toggle is on -- same
  // "cheap but skip it for accounts that never opted in" posture as the sizing-side
  // calibration read further below.
  const policy = getExecutionPolicy();
  const policyCalibration = policy.calibratedGateEnabled
    ? getConfidenceCalibration(tradeJournal.all(), defaultCalibrationMinSamples())
    : undefined;
  const policyCheck = checkExecutionPolicy(signal, policy, policyCalibration);
  if (!manualOverride && !policyCheck.allowed) {
    return { status: "blocked", code: policyCheck.code, reason: policyCheck.reason };
  }

  const now = Date.now();

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
  if (!manualOverride) {
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
      if (riskCheck.code === "daily_loss") {
        riskState.setHaltedForToday(now, account.equity, accountKey);
        // Mirrors metaApiConnection.ts's own daily-loss halt trip -- this one fires when the
        // threshold is first crossed on a manual/voice execution attempt rather than a
        // closing-deal event, but the operator needs the same alert either way.
        const haltNotification = {
          category: "risk_alert" as const,
          title: "JUDE AI — Autopilot locked",
          body: `Daily loss limit (${config.maxDailyLossPct}%) reached on ${accountKey}. No new trades until the next trading day.`,
        };
        void sendNotification(haltNotification);
        void sendWebhookNotification(haltNotification, accountKey);
      }
      return { status: "blocked", code: riskCheck.code, reason: riskCheck.reason };
    }
  }

  // Same shape checkRiskLimits' own maxConcurrentPositions check has (a raw count vs a
  // configured cap), just per-correlation-group instead of whole-account -- see
  // pairCorrelation.ts. Separate from checkRiskLimits since it needs per-position
  // pair+direction, not just a count.
  const correlationCheck = manualOverride
    ? { allowed: true as const, sizeMultiplier: 1, tier: "none" as const, reason: null }
    : checkCorrelatedExposure({
        pair: signal.pair,
        direction: signal.direction,
        openPositions: getOpenPositions(accountKey),
        maxCorrelatedPositions: config.maxCorrelatedPositions,
      });
  if (!correlationCheck.allowed) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${correlationCheck.reason}`);
    return { status: "blocked", code: correlationCheck.code, reason: correlationCheck.reason };
  }
  if (correlationCheck.reason) {
    console.log(`[execution] ${signal.pair} ${signal.id} (${accountKey}): ${correlationCheck.reason}`);
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

  // Same currentPrice already fetched above for the drift check -- a wide spread most
  // often shows up exactly around the same news-spike/market-open/gap conditions drift
  // does, but is a genuinely different failure mode (execution cost, not stale data).
  const spreadCheck = checkSpread({
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    currentBid: currentPrice?.bid,
    currentAsk: currentPrice?.ask,
    maxSpreadFractionOfStop: config.maxSpreadFractionOfStop,
  });
  if (!spreadCheck.allowed) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${spreadCheck.reason}`);
    return { status: "blocked", code: spreadCheck.code, reason: spreadCheck.reason };
  }

  const spec = getSymbolSpecification(signal.pair, accountKey);
  if (!spec) {
    console.error(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): no symbol specification available yet`);
    return { status: "blocked", code: "no_symbol_spec", reason: "no symbol specification available yet" };
  }

  // An explicit per-trade override (the Trade Proposal card's "Edit Risk" field) is a
  // human decision for this one trade specifically -- never further scaled by tier or
  // correlation, same way it already bypasses config.riskPerTradePct entirely. Only the
  // configured base % goes through confidence sizing and correlation-aware sizing (see
  // positionSizing.ts's own doc comment and checkCorrelatedExposure above).
  //
  // Calibration/breakdown are only computed when their own sizing toggle is actually
  // enabled -- a cheap, synchronous read over the in-memory journal either way, but no
  // reason to do it on every execution attempt for accounts that never opted in.
  const calibration = config.confidenceSizingEnabled ? getConfidenceCalibration(tradeJournal.all(), defaultCalibrationMinSamples()) : undefined;
  const confluenceBreakdown = config.confluenceSizingEnabled ? getConfluenceBreakdown(tradeJournal.all()) : undefined;

  // Graduated de-escalation + adaptive engine/session sizing. All three are size-only
  // levers that can only ever SHRINK a position (multiplier <= 1), never grow one, and
  // never apply to an explicit per-trade "Edit Risk" override (a human decision) or to a
  // manual-override trade (already exempted from the account-level gates above). Each is
  // computed only when its own toggle is on -- the journal read is cheap but pointless
  // for accounts that never opted in. See deEscalation.ts / adaptiveEdge.ts.
  const journalEntries = config.deEscalationEnabled || config.adaptiveEngineSizingEnabled || config.sessionEdgeSizingEnabled ? tradeJournal.all() : [];
  const deEscalation =
    config.deEscalationEnabled && !manualOverride && riskPctOverride === undefined
      ? deEscalationSizeMultiplier({
          startOfDayEquity: dayState.startOfDayEquity,
          currentEquity: account.equity,
          maxDailyLossPct: config.maxDailyLossPct,
          deEscalationFraction: config.deEscalationFraction,
          deEscalationSizeMultiplier: config.deEscalationSizeMultiplier,
        })
      : { active: false as const, sizeMultiplier: 1 as const };
  const engineEdge =
    config.adaptiveEngineSizingEnabled && !manualOverride && riskPctOverride === undefined
      ? engineSizeMultiplier(journalEntries, signal.source, { minSamples: config.edgeMinSamples })
      : { sizeMultiplier: 1 };
  const sessionEdge =
    config.sessionEdgeSizingEnabled && !manualOverride && riskPctOverride === undefined
      ? sessionSizeMultiplier(journalEntries, signal.session, { minSamples: config.edgeMinSamples })
      : { sizeMultiplier: 1 };
  if (deEscalation.active) {
    console.log(`[execution] de-escalation active (${deEscalation.drawdownPct.toFixed(2)}% >= ${deEscalation.thresholdPct.toFixed(2)}%): size x${deEscalation.sizeMultiplier}`);
  }
  if (engineEdge.sizeMultiplier < 1 && "reason" in engineEdge) {
    console.log(`[execution] adaptive engine sizing: ${engineEdge.reason}`);
  }
  if (sessionEdge.sizeMultiplier < 1 && "reason" in sessionEdge) {
    console.log(`[execution] session edge sizing: ${sessionEdge.reason}`);
  }

  const riskPct =
    riskPctOverride !== undefined && Number.isFinite(riskPctOverride) && riskPctOverride > 0
      ? riskPctOverride
      : confidenceAdjustedRiskPct(config.riskPerTradePct, signal.tier, config, calibration) *
        correlationCheck.sizeMultiplier *
        confluenceAdjustedMultiplier(signal.confluences, config, confluenceBreakdown) *
        deEscalation.sizeMultiplier *
        engineEdge.sizeMultiplier *
        sessionEdge.sizeMultiplier;
  // See positionSizing.ts's own doc comment on floorToBrokerMinimum -- only ever true for
  // a "manual" signal (the operator's own hand-built trade, reviewed and clicked by them
  // directly), never for an SMC/range/TradingView signal firing on its own. Confirmed real
  // user request: a small live account balance was silently skipping every manual trade
  // (computed lots always below the broker minimum at the configured risk %), and the
  // operator explicitly wants to be able to trade with whatever balance they currently
  // have rather than be blocked outright.
  //
  // But that intent is about the *configured* risk being too small for the account size --
  // it never means "flooring should override a deliberate safety shrink." de-escalation and
  // adaptive engine/session sizing above can only ever shrink riskPct (see their own comment),
  // and if any of them are currently active, a manual trade's lots landing below the broker
  // minimum means the safety system decided to trade less, not that the account is too small
  // -- flooring it back up here would silently trade at (or above) full unshrunk risk exactly
  // when those systems said not to.
  const manualSizingUnshrunk = deEscalation.sizeMultiplier === 1 && engineEdge.sizeMultiplier === 1 && sessionEdge.sizeMultiplier === 1;
  const sizing = computeLotSize(signal, account.equity, riskPct, spec, undefined, signal.source === "manual" && manualSizingUnshrunk);
  if ("skipped" in sizing) {
    console.log(`[execution] skip ${signal.pair} ${signal.id} (${accountKey}): ${sizing.reason}`);
    return { status: "skipped_sizing", reason: sizing.reason };
  }

  // The broker rejects a market order outright ("Invalid stops"/"Validation failed") if
  // entry/stopLoss/takeProfit don't land on a real multiple of the symbol's own tick size
  // -- a signal's ATR-derived prices carry whatever binary-floating-point precision the
  // arithmetic happened to produce, which on a wider-tick instrument (XAU/USD, BTC/USD)
  // essentially never lands exactly on a valid tick by chance. Rounded here, once, right
  // before both the journal record and the broker call, so what gets logged always
  // matches what was actually sent -- never rounded at signal-construction time, so the
  // dashboard still shows the engine's true computed level.
  const entry = roundToTick(signal.entry, spec.point);
  const stopLoss = roundToTick(signal.stopLoss, spec.point);
  const takeProfit = roundToTick(signal.takeProfit, spec.point);

  // Reserve the signal id before the broker call — everything above this point is
  // read-only and safe to repeat, but from here on a duplicate call must not re-fire.
  const record = positionStore.recordAttempt({
    id: randomUUID(),
    signalId: signal.id,
    account: accountKey,
    pair: signal.pair,
    timeframe: signal.timeframe,
    direction: signal.direction,
    requestedLots: sizing.lots,
    requestedEntry: entry,
    stopLoss,
    takeProfit,
    takeProfit2: signal.takeProfit2,
    riskPct,
    attemptedAt: now,
  });

  const result = await placeMarketOrder(signal.pair, signal.direction, sizing.lots, stopLoss, takeProfit, entry, accountKey);

  if (!result.success) {
    positionStore.markRejected(signal.id, result.message, accountKey);
    console.error(`[execution] rejected ${signal.pair} ${signal.id} (${accountKey}): ${result.message}`, {
      numericCode: result.numericCode,
      stringCode: result.stringCode,
      lots: sizing.lots,
    });
    void sendNotification({
      category: "order_rejected",
      title: `JUDE AI — Order rejected: ${signal.pair}`,
      body: result.message,
      data: { signalId: signal.id, pair: signal.pair, account: accountKey },
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
    `[execution] filled ${signal.direction} ${sizing.lots} lots ${signal.pair} @ ${result.filledEntry} (signal ${signal.id}, ${accountKey}, tier ${signal.tier}, risked ${riskPct.toFixed(3)}%)`
  );
  void sendNotification({
    category: "trade_opened",
    title: `JUDE AI — Position opened: ${signal.pair}`,
    body: `${signal.direction === "long" ? "LONG" : "SHORT"} ${sizing.lots} lots @ ${formatPrice(signal.pair, result.filledEntry)} (${accountKey})`,
    data: { signalId: signal.id, pair: signal.pair, account: accountKey },
  });
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
