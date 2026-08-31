// The package's default ESM entry point ("metaapi.cloud-sdk") resolves to a browser
// build that references `window` at module scope and crashes under Node. Use the
// explicit Node build instead — see https://github.com/metaapi/metaapi-javascript-sdk.
import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk/node";
import type {
  MarketDataSubscription,
  MarketDataUnsubscription,
  MetatraderAccount,
  MetatraderCandle,
  MetatraderDeal,
  MetatraderSymbolPrice,
  MetatraderTradeResponse,
  StreamingMetaApiConnectionInstance,
  TrailingStopLoss,
} from "metaapi.cloud-sdk/node";
import type { AccountInfo, AccountKey, Candle, OpenPosition, Pair, SymbolSpec, Timeframe } from "./types";
import { PAIRS } from "./types";
import { candleStore } from "./candleStore";
import { priceStore } from "./priceStore";
import { eventBus } from "./eventBus";
import { evaluateSignal } from "./signalEngine";
import { evaluateRangeSignal } from "./rangeEngine";
import { confirmsDirection, M5_CONFIRMATION_BARS } from "./m5Confirmation";
import { publishSignal } from "./signalPublisher";
import { predictionStore } from "./predictionStore";
import { ALL_PAIRS, brokerSymbol, pairForBrokerSymbol } from "./symbols";
import { seedHistoricalCandles } from "./seedHistory";
import { loadExecutionConfig } from "./executionConfig";
import { isDailyLossBreached } from "./riskManager";
import { riskState } from "./riskState";
import { sendNotification } from "./pushNotifier";
import { isPending } from "./pendingInvalidationClose";
import { calculateAdx } from "./indicators/adx";
import { calculateAtr } from "./indicators/atr";
import { detectMarketRegime } from "./marketRegime";
import { assessPositionRisk } from "./positionRiskNarration";
import { getLastPositionRiskLevel, setLastPositionRiskLevel } from "./positionRiskStore";
import { generateTradeRetrospective } from "../chat/tradeRetrospective";
import { checkNews } from "./newsFilter";
import { emaTrendDirection, emaTrendGapPct } from "./indicators/emaTrend";
import { scoreSetupQuality } from "./setupQualityScore";
import {
  tradeJournal,
  getConfidenceCalibration,
  defaultCalibrationMinSamples,
  calibrationMilestoneNotifications,
  type JournalCloseReason,
} from "./tradeJournal";
import { positionStore } from "./positionStore";
import { consume as consumeInvalidationMark } from "./invalidationMarker";
import { dealDedup } from "./dealDedup";

// Three independent signal engines run concurrently per pair, one per timeframe --
// each closed candle on any of these is evaluated on its own, sharing the same
// higherTimeframes (h1/h4/d1) trend-confirmation stack (see the call site below).
// For the "1h" engine specifically, higherTimeframes.h1 ends up being the exact same
// candles as the signal series itself, making that one trend-agreement check
// self-referential -- still a real check (H1 EMA50/200 vs. the implied direction),
// just tautological-sounding; not special-cased since it's harmless and avoids
// branching complexity in signalEngine.ts for a cosmetic redundancy.
const SIGNAL_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];
const TRACKED_TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

// The demo account exists purely as a second AUTO-EXECUTION target for DEMO engine mode
// -- never a second price feed or a second signal engine. Only "live" writes into the
// shared candleStore/priceStore/signalStore or calls evaluateSignal(); if both accounts
// published market data, two connections streaming the same broker prices would race to
// write duplicate/conflicting candle and signal events. The demo connection still needs
// its own terminalState (for getAccountInformation/getSymbolSpecification/position count
// when executing against it), which the SDK maintains internally regardless of what this
// listener does with the events.
// Shared between the initial per-pair subscribe loop and onSubscriptionDowngraded's own
// recovery re-subscribe below, so the two can never silently drift apart. No "5m" here
// on purpose -- it's the one Timeframe value that's neither a SIGNAL_TIMEFRAMES entry
// (no signal engine ever evaluates it) nor part of higherTimeframes (h1/h4/d1), nor
// selectable on the dashboard chart (see TimeframeSelector.tsx's own comment) -- a live
// subscription for it was pure unused cost. Dropping it was the direct fix for MetaApi
// repeatedly downgrading (removing candle subscriptions from) XAUUSDm/XAGUSDm/USOILm/
// UKOILm due to rate limits, seen continuously in production logs -- those symbols
// stopped receiving live candle updates at all while downgraded, which is what
// "candlesticks not moving" actually was. /api/candles still answers a "5m" request
// from seedHistory.ts's one-time REST-fetched snapshot, it just won't tick live. M5
// entry confirmation (see fetchRecentCandles below) deliberately does NOT change this --
// it fetches on demand via REST only at the rare moment a signal is about to fire, never
// a live stream, so it can't reintroduce the same problem.
const LIVE_MARKET_DATA_SUBSCRIPTIONS: MarketDataSubscription[] = [
  { type: "quotes" },
  { type: "candles", timeframe: "15m" },
  { type: "candles", timeframe: "30m" },
  { type: "candles", timeframe: "1h" },
  { type: "candles", timeframe: "4h" },
  { type: "candles", timeframe: "1d" },
];

// MetaApi's real documented limit (https://metaapi.cloud/docs/client/rateLimiting/) for
// the subscribeToMarketData call itself is 10 requests per account per 60 seconds --
// ACCOUNT-WIDE, not per-symbol. Spacing every call 6.5s apart (just past the
// mathematical minimum of 60/10=6s, for margin) is what actually respects this for any
// pair count -- shared here between connect()'s own initial paced subscribe loop and
// MarketSyncListener's downgrade-recovery queue below, which used to give every
// downgraded symbol its own fully independent retry timer instead of sharing this same
// pacing. That was the direct cause of a real production incident (2026-08-31): when a
// whole batch of pairs downgrades together (exactly what happens at the weekly market
// reopen), their independent jittered retries landed back in roughly the same window
// too, collectively re-tripping this same account-wide budget and downgrading the same
// batch again -- an 8-hour, self-sustaining storm across every monitored pair.
const SUBSCRIBE_STAGGER_MS = 6500;

// Duck-typed, NOT `instanceof TooManyRequestsError` -- verified directly (require() the
// package the same way webpack/Next.js's CJS interop does, not a Node ESM dynamic
// import(), which gives a misleadingly different export set) that this package's own
// .d.ts LIES about that class being reachable from the "metaapi.cloud-sdk/node" entry
// point actually used here: `typeof require("metaapi.cloud-sdk/node").TooManyRequestsError`
// is really `undefined` at runtime. `instanceof undefined` throws, so that check would
// have taken down every single recovery attempt's error handling in production. This
// shape (status 429 + a metadata.recommendedRetryTime) is instead copied directly from a
// real caught error logged in production, so it's guaranteed to match what's actually
// thrown, independent of which module instance constructed it.
function rateLimitRetryTime(error: unknown): string | Date | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const metadata = (error as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const retryTime = (metadata as { recommendedRetryTime?: unknown }).recommendedRetryTime;
  return typeof retryTime === "string" || retryTime instanceof Date ? retryTime : undefined;
}

// Applies MetaApi's own recommended retry time with sane bounds -- a real production
// incident hit an entirely different limit than subscribeToMarketData's per-minute cap:
// an hourly per-server CPU-credit budget (ws:subscribeToMarketData, 180000 credits/1h,
// exceededConfig "perServer"), exhausted by a full day of repeated reconnect storms each
// re-subscribing all 18 pairs. A fixed jittered retry (the old behavior) can't know about
// that budget at all and just keeps re-attempting into it. Clamped to [10s, 20min]: never
// so short it re-trips instantly, never so long a single bad reading leaves a symbol dark
// for the rest of the day.
export function retryDelayFromError(error: unknown, fallbackMs: number): number {
  const retryTime = rateLimitRetryTime(error);
  if (retryTime === undefined) return fallbackMs;
  const retryAt = new Date(retryTime).getTime();
  if (Number.isNaN(retryAt)) return fallbackMs;
  return Math.min(Math.max(retryAt - Date.now(), 10_000), 20 * 60 * 1000);
}

class MarketSyncListener extends SynchronizationListener {
  // Symbols with a recovery already queued or in flight -- without this, the SAME
  // symbol getting downgraded again before its first recovery has even run stacks a
  // second, third, fourth entry in the queue for no added benefit.
  private pendingRecovery = new Set<string>();
  // Recoveries wait here rather than each scheduling their own independent timer --
  // see drainRecoveryQueue's own doc comment for why an uncoordinated per-symbol timer
  // was the actual bug.
  private recoveryQueue: { symbol: string; isRetry: boolean }[] = [];
  private draining = false;

  // Only set for the "live" account (see connect() below) -- needed so
  // onSubscriptionDowngraded can re-subscribe a downgraded symbol itself, rather than
  // just logging and leaving it broken until the next full reconnect.
  constructor(
    private accountKey: AccountKey,
    private connection?: StreamingMetaApiConnectionInstance
  ) {
    super();
  }

  /**
   * Belt-and-suspenders on top of the paced subscribe loop in connect(): if a symbol
   * still gets downgraded anyway (a temporary tighter limit, a MetaApi-side policy
   * change, a whole-account resubscribe burst like the weekly market reopen), this is
   * what actually recovers it, instead of it silently staying broken until the next
   * full reconnect -- which is what "candlesticks not moving" has been three times now.
   */
  async onSubscriptionDowngraded(
    _instanceIndex: string,
    symbol: string,
    _updates: MarketDataSubscription[],
    unsubscriptions: MarketDataUnsubscription[]
  ): Promise<void> {
    if (this.accountKey !== "live" || !this.connection) return;
    // Defensive, not just typed loosely -- a real production log from this exact event
    // showed the SDK's own "updates" argument as undefined despite its declared type
    // promising an array, so "unsubscriptions" isn't trusted to always be one either.
    const lostCandles = Array.isArray(unsubscriptions) && unsubscriptions.some((u) => u.type === "candles");
    if (!lostCandles) return;

    const pair = pairForBrokerSymbol(symbol);
    // A symbol outside today's PAIRS (e.g. a stale/ghost subscription the terminal
    // never released after a since-reverted PAIRS change -- see the explicit
    // unsubscribe-stale-symbols step in connect() above) must never be recovered here.
    // Confirmed as the real mechanism that turned a one-time downgrade into a
    // sustained, self-perpetuating storm: blindly re-subscribing it just spends the
    // same 10-calls/60s account-wide budget legitimate PAIRS symbols share, causing
    // THEM to downgrade next, whose own recovery attempts spend more budget in turn --
    // observed hours after the 2026-08-28 revert, with zero PAIRS change involved.
    if (!pair || !PAIRS.includes(pair)) return;

    if (this.pendingRecovery.has(symbol)) return;
    this.pendingRecovery.add(symbol);

    console.error(`[market] ${symbol} (${pair}) candle subscription downgraded -- queued for recovery`);
    this.recoveryQueue.push({ symbol, isRetry: false });
    void this.drainRecoveryQueue();
  }

  /**
   * Drains queued recoveries ONE AT A TIME, spaced SUBSCRIBE_STAGGER_MS apart -- the
   * actual fix for a real production incident (2026-08-31): the previous version gave
   * every downgraded symbol its own fully independent timer (a 65-95s jittered wait,
   * then retry). That sounds staggered but isn't, because MetaApi's 10-calls/60s
   * subscribeToMarketData limit is ACCOUNT-WIDE, not per-symbol -- when a whole batch
   * of pairs downgrades together (exactly what happens at the weekly market reopen,
   * when every pair's subscription re-establishes near-simultaneously), their
   * independent jittered retries landed back in roughly the same ~30s window too,
   * collectively re-tripping the same shared budget and downgrading the same batch
   * again. Confirmed directly in production logs: an 8-hour, self-sustaining storm
   * across every monitored pair, still going when this fix was written. A single
   * serialized queue means only one recovery call is ever in flight account-wide at a
   * time, regardless of how many symbols need it -- the same principle connect()'s own
   * initial subscribe loop already uses, just applied to the recovery path too.
   */
  private async drainRecoveryQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // One settle period before the FIRST attempt of this drain cycle -- past a full
      // rate-limit window (60s) since the downgrade(s) that started it -- paid once per
      // drain cycle, not stacked per symbol queued into it.
      await new Promise((resolve) => setTimeout(resolve, 65_000 + Math.random() * 10_000));

      while (this.recoveryQueue.length > 0) {
        const next = this.recoveryQueue.shift();
        if (!next || !this.connection) break;
        const { symbol, isRetry } = next;
        try {
          await this.connection.subscribeToMarketData(symbol, LIVE_MARKET_DATA_SUBSCRIPTIONS);
          this.pendingRecovery.delete(symbol);
        } catch (error: unknown) {
          console.error(`[market] ${symbol} recovery re-subscribe failed:`, error);
          // At most 2 attempts total per symbol -- a bounded retry, not a loop. Past
          // that, give up; the next real downgrade event (or the initial paced
          // subscribe loop on the next reconnect) will pick it back up.
          if (!isRetry && rateLimitRetryTime(error) !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayFromError(error, 0)));
            this.recoveryQueue.push({ symbol, isRetry: true });
            continue;
          }
          this.pendingRecovery.delete(symbol);
        }
        if (this.recoveryQueue.length > 0) await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_STAGGER_MS));
      }
    } finally {
      this.draining = false;
    }
  }

  async onSymbolPricesUpdated(_instanceIndex: string, prices: MetatraderSymbolPrice[]): Promise<void> {
    if (prices.length > 0) stateFor(this.accountKey).lastUpdateAt = Date.now();
    if (this.accountKey !== "live") return;

    for (const raw of prices) {
      const pair = pairForBrokerSymbol(raw.symbol);
      if (!pair) continue;

      const time = raw.time.getTime();
      priceStore.set({ pair, bid: raw.bid, ask: raw.ask, time });
      eventBus.publish({ type: "price", pair, bid: raw.bid, ask: raw.ask, time });
    }
  }

  async onCandlesUpdated(_instanceIndex: string, candles: MetatraderCandle[]): Promise<void> {
    if (this.accountKey !== "live") return; // demo never subscribes to candles; guard is defense-in-depth

    for (const raw of candles) {
      const pair = pairForBrokerSymbol(raw.symbol);
      if (!pair) continue;
      if (!TRACKED_TIMEFRAMES.includes(raw.timeframe as Timeframe)) continue;
      const timeframe = raw.timeframe as Timeframe;

      const candle: Candle = {
        time: raw.time.getTime(),
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        tickVolume: raw.tickVolume,
      };

      // Snapshot the series as it stood before this update: if a new bar just
      // started, this snapshot's last element is the bar that just closed, which
      // is exactly what the signal engine should evaluate (never the forming bar).
      const priorSeries = candleStore.get(pair, timeframe);
      const priorLast = priorSeries[priorSeries.length - 1];
      const barJustClosed = Boolean(priorLast) && candle.time > (priorLast?.time ?? -Infinity);

      candleStore.upsert(pair, timeframe, candle);
      eventBus.publish({ type: "candle", pair, timeframe, candle });

      if (barJustClosed && SIGNAL_TIMEFRAMES.includes(timeframe)) {
        const higherTimeframes = {
          h1: candleStore.get(pair, "1h"),
          h4: candleStore.get(pair, "4h"),
          d1: candleStore.get(pair, "1d"),
        };
        let evaluation = evaluateSignal(priorSeries, pair, timeframe, higherTimeframes);
        // M5 entry confirmation -- a voluntarily-added quality gate on top of
        // everything evaluateSignal itself already checks (see m5Confirmation.ts).
        // Only ever runs on the rare candle that would otherwise become a signal, an
        // on-demand REST fetch, never a live subscription (see fetchRecentCandles's
        // own doc comment for why that distinction matters here specifically).
        if (evaluation.status === "signal" && loadExecutionConfig(this.accountKey).m5ConfirmationEnabled) {
          const m5Candles = await fetchRecentCandles(pair, "5m", M5_CONFIRMATION_BARS, this.accountKey);
          if (!confirmsDirection(m5Candles, evaluation.signal.direction)) {
            evaluation = { status: "no_trade", reason: { code: "m5_not_confirmed", impliedDirection: evaluation.signal.direction } };
          }
        }
        const time = Date.now();
        // Same emaTrendDirection call signalEngine.ts's own hard trend-agreement gate
        // already makes on these exact series -- recomputed here (cheap: two EMAs over
        // <=300 candles) so the dashboard can show D1/H4/H1 bias for every update, not
        // just the ones a signal happens to fire or get blocked on for that reason.
        const trends = {
          d1: emaTrendDirection(higherTimeframes.d1),
          h4: emaTrendDirection(higherTimeframes.h4),
          h1: emaTrendDirection(higherTimeframes.h1),
          d1Gap: emaTrendGapPct(higherTimeframes.d1),
          h4Gap: emaTrendGapPct(higherTimeframes.h4),
          h1Gap: emaTrendGapPct(higherTimeframes.h1),
        };
        // Computed independently of evaluateSignal (see marketRegime.ts's own doc
        // comment) -- reuses the exact same closed-candle series and news check, never
        // gates or alters `evaluation` itself, just explains the backdrop it happened
        // against.
        const lastClosed = priorSeries[priorSeries.length - 1];
        const regime = detectMarketRegime(priorSeries, calculateAdx(priorSeries), calculateAtr(priorSeries), checkNews(pair, lastClosed.time));
        predictionStore.set(pair, timeframe, { pair, timeframe, source: "smc", evaluation, time, regime, trends });
        eventBus.publish({ type: "prediction", pair, timeframe, source: "smc", evaluation, time, regime, trends });

        // Position-risk narration -- only on the freshest timeframe (15m), so this
        // doesn't fire the same check three times per candle-close cascade (15m/30m/1h
        // can all close together on some minute boundaries). "live" only, matching this
        // whole listener's own top-of-function guard -- demo never streams candles.
        // Purely additive: narrates via a new event + notification, never touches
        // sizing, stop loss, or execution (see positionRiskNarration.ts's own doc
        // comment).
        if (timeframe === "15m") {
          for (const position of getOpenPositions("live")) {
            if (position.pair !== pair) continue;
            const assessment = assessPositionRisk(position.direction, regime, trends);
            const previousLevel = getLastPositionRiskLevel(position.id);
            setLastPositionRiskLevel(position.id, assessment.level);
            if (previousLevel === assessment.level) continue; // no real change -- see positionRiskStore.ts
            eventBus.publish({
              type: "position_risk",
              positionId: position.id,
              pair: position.pair,
              direction: position.direction,
              level: assessment.level,
              reason: assessment.reason,
              time,
            });
            if (assessment.level !== "aligned") {
              void sendNotification({
                category: "risk_alert",
                title: `JUDE AI — ${assessment.level === "warning" ? "Warning" : "Caution"}: ${position.pair}`,
                body: assessment.reason,
                data: { positionId: position.id, pair: position.pair },
              });
            } else if (previousLevel !== undefined) {
              // The other half of a real user request: not just "something's wrong" but
              // "tell me the moment it's not wrong anymore". previousLevel !== undefined
              // excludes a position's very first assessment (nothing to have cleared from
              // yet) -- only a genuine caution/warning -> aligned transition notifies.
              void sendNotification({
                category: "risk_alert",
                title: `JUDE AI — Cleared: ${position.pair}`,
                body: `The ${previousLevel} on your ${position.direction === "long" ? "BUY" : "SELL"} position has cleared -- market conditions are aligned again.`,
                data: { positionId: position.id, pair: position.pair },
              });
            }
          }
        }

        if (evaluation.status === "signal") {
          publishSignal(evaluation.signal);
          // Snapshot the decision context now, while it's still real -- signalStore
          // itself prunes after 4 hours (far shorter than a trade can stay open), which
          // is exactly why the trade journal can't just read it back from there later.
          const signal = evaluation.signal;
          tradeJournal.recordSignalContext({
            signalId: signal.id,
            pair: signal.pair,
            timeframe: signal.timeframe,
            direction: signal.direction,
            regime,
            setupQuality: scoreSetupQuality(signal, regime),
            confidence: signal.confidence,
            signerBDirection: signal.signerBDirection,
            signerBConfidence: signal.signerBConfidence,
            adx: signal.adx,
            rsi: signal.rsi,
            newsStatus: signal.newsStatus,
            session: signal.session,
            createdAt: signal.createdAt,
            confluences: signal.confluences,
            source: signal.source,
          });
        }
      }

      // rangeEngine.ts's mean-reversion engine, evaluated independently alongside SMC
      // on the exact same closed candle -- 15m only for now (see rangeEngine.ts's own
      // doc comment). No M5 confirmation gate, no trade-journal setup-quality scoring
      // (scoreSetupQuality is SMC-shaped -- e.g. it rewards a "strong_uptrend"/
      // "strong_downtrend" regime, the opposite of what this engine wants, so applying
      // it here would produce a meaningless score, not a real one -- SignalContext.
      // setupQuality is left undefined below for exactly this reason). Decision context
      // IS still recorded (source: "mean_reversion"), same as the SMC block above -- this
      // is what makes getPerformanceBreakdown's "source" dimension (SMC vs. range engine
      // performance, compared head to head) and getConfidenceCalibration/
      // getSignerBCalibration possible for range-engine trades at all; before this they
      // closed into the journal with context: null, same as a context-less TradingView
      // entry, and were invisible to every context-based breakdown.
      if (barJustClosed && timeframe === "15m") {
        const rangeEvaluation = evaluateRangeSignal(priorSeries, pair, timeframe);
        const rangeTime = Date.now();
        const rangeLastClosed = priorSeries[priorSeries.length - 1];
        const rangeRegime = detectMarketRegime(priorSeries, calculateAdx(priorSeries), calculateAtr(priorSeries), checkNews(pair, rangeLastClosed.time));
        const rangeTrends = {
          d1: emaTrendDirection(candleStore.get(pair, "1d")),
          h4: emaTrendDirection(candleStore.get(pair, "4h")),
          h1: emaTrendDirection(candleStore.get(pair, "1h")),
          d1Gap: emaTrendGapPct(candleStore.get(pair, "1d")),
          h4Gap: emaTrendGapPct(candleStore.get(pair, "4h")),
          h1Gap: emaTrendGapPct(candleStore.get(pair, "1h")),
        };
        predictionStore.set(pair, timeframe, {
          pair,
          timeframe,
          source: "mean_reversion",
          evaluation: rangeEvaluation,
          time: rangeTime,
          regime: rangeRegime,
          trends: rangeTrends,
        });
        eventBus.publish({
          type: "prediction",
          pair,
          timeframe,
          source: "mean_reversion",
          evaluation: rangeEvaluation,
          time: rangeTime,
          regime: rangeRegime,
          trends: rangeTrends,
        });
        if (rangeEvaluation.status === "signal") {
          publishSignal(rangeEvaluation.signal);
          const rangeSignal = rangeEvaluation.signal;
          tradeJournal.recordSignalContext({
            signalId: rangeSignal.id,
            pair: rangeSignal.pair,
            timeframe: rangeSignal.timeframe,
            direction: rangeSignal.direction,
            regime: rangeRegime,
            confidence: rangeSignal.confidence,
            signerBDirection: rangeSignal.signerBDirection,
            signerBConfidence: rangeSignal.signerBConfidence,
            adx: rangeSignal.adx,
            rsi: rangeSignal.rsi,
            newsStatus: rangeSignal.newsStatus,
            session: rangeSignal.session,
            createdAt: rangeSignal.createdAt,
            confluences: rangeSignal.confluences,
            source: rangeSignal.source,
          });
        }
      }
    }
  }

  /**
   * Drives the revenge-trading cooldown and passive daily-loss detection (riskState /
   * riskManager) off real position closes -- covers the WHOLE account, not just trades
   * this app opened, matching getOpenPositionCount's same philosophy.
   *
   * `onDealAdded` also fires once per historical deal during the initial sync replay --
   * `connection.synchronized` is still false for that replay window and only flips true
   * once it's caught up, so gating on it here stops years of old trade history from being
   * misread as "just happened" on a brand-new connection. That flag does NOT protect
   * against every later reconnect resync, though -- MetaApi has been observed redelivering
   * the same already-closed deal as a fresh onDealAdded event on later resyncs even while
   * `synchronized` reads true throughout, which is what was tripping phantom "N
   * consecutive losses" cooldowns for a single real loss redelivered several times across
   * today's reconnects/restarts. dealDedup.hasProcessed/markProcessed below is the actual
   * fix -- a durable, deal-id-keyed guard that no redelivery can get past twice.
   */
  async onDealAdded(_instanceIndex: string, deal: MetatraderDeal): Promise<void> {
    const state = stateFor(this.accountKey);
    const connection = state.connection;
    if (!connection?.synchronized) return;

    const isPositionClose = deal.entryType === "DEAL_ENTRY_OUT" || deal.entryType === "DEAL_ENTRY_OUT_BY";
    const isTradeDeal = deal.type === "DEAL_TYPE_BUY" || deal.type === "DEAL_TYPE_SELL";
    if (!isPositionClose || !isTradeDeal) return;

    if (dealDedup.hasProcessed(deal.id)) {
      console.log(`[metaapi] onDealAdded: deal ${deal.id} already processed for ${this.accountKey} -- skipping redelivered event`);
      return;
    }

    const equity = connection.terminalState.accountInformation?.equity;
    if (equity === undefined) return;

    const now = Date.now();
    dealDedup.markProcessed(deal.id, this.accountKey, now);
    const config = loadExecutionConfig(this.accountKey);

    const pair = deal.symbol ? pairForBrokerSymbol(deal.symbol) : undefined;
    // Consumed exactly once here, before either reader below -- invalidationMarker's own
    // consume() deletes the mark on read (deliberately single-use, see its own doc
    // comment), so the notification and the journal entry must share this one read
    // rather than each calling consume() independently, which would silently starve
    // whichever ran second.
    const wasInvalidation = deal.positionId !== undefined && consumeInvalidationMark(deal.positionId);
    if (pair) void sendNotification(closedPositionNotification(pair, deal, this.accountKey, wasInvalidation));
    // Sibling recording action alongside the notification above -- never alters the
    // risk-state logic below it. Only ever produces a journal entry for a close this
    // app itself opened (a matching ExecutedTrade must exist); a manually opened and
    // closed position has no signal/entry/stop-loss to derive R from, so it's left out
    // rather than guessed.
    if (pair) recordJournalOutcome(pair, deal, this.accountKey, wasInvalidation);

    // Captured before recordTradeClosed mutates it in place -- the only way to tell
    // "cooldown just tripped on this deal" from "cooldown was already active" below.
    const cooldownUntilBefore = riskState.current(now, equity, this.accountKey).cooldownUntil;
    riskState.recordTradeClosed(now, equity, deal.profit, config.maxConsecutiveLosses, config.cooldownMinutes, this.accountKey);

    const dayState = riskState.current(now, equity, this.accountKey);
    if (cooldownUntilBefore === null && dayState.cooldownUntil !== null) {
      void sendNotification({
        category: "risk_alert",
        title: "JUDE AI — Cooldown active",
        body: `${config.maxConsecutiveLosses} consecutive losses on ${this.accountKey}. New entries paused for ${config.cooldownMinutes} minutes.`,
      });
    }

    if (!dayState.haltedForToday && isDailyLossBreached(dayState.startOfDayEquity, equity, config.maxDailyLossPct)) {
      riskState.setHaltedForToday(now, equity, this.accountKey);
      void sendNotification({
        category: "risk_alert",
        title: "JUDE AI — Autopilot locked",
        body: `Daily loss limit (${config.maxDailyLossPct}%) reached on ${this.accountKey}. No new trades until the next trading day.`,
      });
    }
  }
}

/** Checked before the broker's own deal.reason mapping -- an API-initiated invalidation
 * close (see positionInvalidation.ts) reads to MetaApi as an ordinary client-side close
 * (DEAL_REASON_CLIENT/EXPERT), indistinguishable from a genuine manual close by reason
 * alone. `wasInvalidation` is the one shared read of invalidationMarker.ts's short-lived
 * mark (see onDealAdded's own comment on why it can't be read again here). */
function journalCloseReasonFor(deal: MetatraderDeal, wasInvalidation: boolean): JournalCloseReason {
  if (wasInvalidation) return "invalidation";
  if (deal.reason === "DEAL_REASON_SL") return "stop_loss";
  if (deal.reason === "DEAL_REASON_TP") return "take_profit";
  if (deal.reason === "DEAL_REASON_CLIENT" || deal.reason === "DEAL_REASON_MOBILE" || deal.reason === "DEAL_REASON_WEB" || deal.reason === "DEAL_REASON_EXPERT") {
    return "manual";
  }
  return "other";
}

/** Joins a closing deal back to the ExecutedTrade this app itself opened (via
 * positionStore's brokerPositionId <-> signalId link), then hands the real entry/
 * stop-loss/lots off to tradeJournal.recordOutcome for its own R-multiple math --
 * never recomputed here, so there's only one place that math lives. */
function recordJournalOutcome(pair: Pair, deal: MetatraderDeal, accountKey: AccountKey, wasInvalidation: boolean): void {
  if (deal.positionId === undefined || deal.price === undefined) return;
  const trade = positionStore.all().find((t) => t.account === accountKey && t.brokerPositionId === deal.positionId);
  if (!trade) return;

  const entry = tradeJournal.recordOutcome({
    dealId: String(deal.id),
    signalId: trade.signalId,
    account: accountKey,
    pair,
    direction: trade.direction,
    entryPrice: trade.filledEntry ?? trade.requestedEntry,
    stopLoss: trade.stopLoss,
    lots: trade.requestedLots,
    contractSize: getSymbolSpecification(pair, accountKey)?.contractSize,
    exitPrice: deal.price,
    profit: deal.profit,
    reason: journalCloseReasonFor(deal, wasInvalidation),
    closedAt: deal.time.getTime(),
  });

  checkCalibrationMilestone();

  // Only for a real engine's own signal (never a synthetic manual_test order, which
  // has no real setup to retrospect on) -- see generateTradeRetrospective's own doc
  // comment on why this is fire-and-forget and can never affect execution/risk/the
  // journal entry itself (already durably recorded above).
  if (entry.context?.source === "smc" || entry.context?.source === "mean_reversion") {
    void generateTradeRetrospective(entry).catch((error: unknown) => {
      console.error(`[metaapi] trade retrospective generation failed for deal ${deal.id}:`, error);
    });
  }
}

// Thin orchestration wrapper -- the actual milestone logic is pure and tested (see
// tradeJournal.ts's calibrationMilestoneNotifications), this just supplies the real data
// and fires the notification, on the operator's own explicit "wait for real data"
// decision so that wait has visible progress instead of requiring a manual Settings check.
function checkCalibrationMilestone(): void {
  const minSamples = defaultCalibrationMinSamples();
  const buckets = getConfidenceCalibration(tradeJournal.all(), minSamples);
  for (const notification of calibrationMilestoneNotifications(buckets, minSamples)) {
    void sendNotification({ category: "calibration_update", title: notification.title, body: notification.body });
  }
}

function closedPositionNotification(pair: Pair, deal: MetatraderDeal, accountKey: AccountKey, wasInvalidation: boolean) {
  const outcome = deal.profit >= 0 ? "Profit" : "Loss";
  // wasInvalidation takes priority over the broker's own deal.reason -- see
  // positionInvalidation.ts's own flow: an opposite signal fires, closes this losing
  // position, and (via the exact same event) opens the new, opposite-direction one --
  // the single most important kind of close to recognize at a glance, and otherwise
  // indistinguishable from an ordinary manual close (MetaApi reports both the same way).
  const reasonLabel = wasInvalidation
    ? "Reversed — opposite signal fired"
    : deal.reason === "DEAL_REASON_SL"
      ? "Stop loss hit"
      : deal.reason === "DEAL_REASON_TP"
        ? "Take profit hit"
        : "Position closed";
  return {
    category: "trade_closed" as const,
    title: `JUDE AI — ${reasonLabel}: ${pair}`,
    body: `${outcome} ${deal.profit >= 0 ? "+" : ""}${deal.profit.toFixed(2)} on ${accountKey}`,
    data: { pair, profit: deal.profit, reason: deal.reason },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const ACCOUNT_ENV_VARS: Record<AccountKey, { token: string; accountId: string }> = {
  live: { token: "METAAPI_TOKEN", accountId: "METAAPI_ACCOUNT_ID" },
  demo: { token: "METAAPI_DEMO_TOKEN", accountId: "METAAPI_DEMO_ACCOUNT_ID" },
};

/** Env-var presence only — no SDK call. Used to fail closed (reject a DEMO-mode switch,
 * or a demo auto-execution attempt) before ever assuming a demo connection exists. */
export function isAccountConfigured(accountKey: AccountKey): boolean {
  const vars = ACCOUNT_ENV_VARS[accountKey];
  return Boolean(process.env[vars.token] && process.env[vars.accountId]);
}

// One connection per account, read by the broker accessors below. This is the only
// module allowed to hold a reference to the SDK connection — everything else (execution
// engine, risk manager, API routes) goes through the narrow functions here. globalThis-
// keyed for the same reason every store in this app is (see priceStore.ts) — a plain
// module-level variable here isn't reliably shared across Next.js's route-handler and
// instrumentation module instances, which previously (before this was globalThis-keyed)
// silently made every accessor below think there was no connection even while data was
// streaming fine through the (correctly globalThis-keyed) priceStore/candleStore.
interface ConnectionState {
  connection: StreamingMetaApiConnectionInstance | null;
  lastUpdateAt: number | null;
  // The account ENTITY (not the streaming connection) -- kept only so fetchRecentCandles
  // below can make on-demand getHistoricalCandles REST calls after boot, same object
  // connect() already creates once for seedHistoricalCandles.
  account: MetatraderAccount | null;
}
const connectionStatesKey = Symbol.for("forex-ai.metaApiConnection.states");
type GlobalWithConnectionStates = typeof globalThis & { [connectionStatesKey]?: Map<AccountKey, ConnectionState> };
const connectionStatesGlobal = globalThis as GlobalWithConnectionStates;
const connectionStates: Map<AccountKey, ConnectionState> =
  connectionStatesGlobal[connectionStatesKey] ?? (connectionStatesGlobal[connectionStatesKey] = new Map());

// Never falls back to another account's state — a demo connection that was never
// started (not configured, or still starting up) must read as "no connection", not
// silently pick up live's connection. This is the mechanism that makes an unconfigured
// or not-yet-ready DEMO fail closed.
function stateFor(accountKey: AccountKey): ConnectionState {
  let state = connectionStates.get(accountKey);
  if (!state) {
    state = { connection: null, lastUpdateAt: null, account: null };
    connectionStates.set(accountKey, state);
  }
  return state;
}

// Bumped at the start of every connect() attempt (including forceReconnect's) and
// checked between each staggered network call inside it -- an attempt that's been
// superseded by a newer one stops issuing further subscribe/unsubscribe calls instead
// of continuing to run in the background. Without this, a forceReconnect fired while the
// previous connect() was still stuck mid-loop left BOTH attempts making calls against
// the same account's 10-calls/60s MetaApi rate limit concurrently -- confirmed as a real
// production incident (2026-08-30): every watchdog escalation compounded the very
// rate-limit contention it was trying to recover from instead of clearing it, so the
// connection never actually came back until a code fix, not just a redeploy.
const connectGenerationKey = Symbol.for("forex-ai.metaApiConnection.connectGeneration");
type GlobalWithConnectGeneration = typeof globalThis & { [connectGenerationKey]?: Map<AccountKey, number> };
const connectGenerationGlobal = globalThis as GlobalWithConnectGeneration;
const connectGeneration: Map<AccountKey, number> =
  connectGenerationGlobal[connectGenerationKey] ?? (connectGenerationGlobal[connectGenerationKey] = new Map());

async function connect(accountKey: AccountKey): Promise<void> {
  const myGeneration = (connectGeneration.get(accountKey) ?? 0) + 1;
  connectGeneration.set(accountKey, myGeneration);
  const isSuperseded = () => connectGeneration.get(accountKey) !== myGeneration;

  const vars = ACCOUNT_ENV_VARS[accountKey];
  const token = requireEnv(vars.token);
  const accountId = requireEnv(vars.accountId);

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);

  // Only "live" needs candle history -- "demo" is purely an execution target (see
  // MarketSyncListener above), not a second signal engine. Fire-and-forget, not
  // awaited: this used to run BEFORE the streaming connect below, meaning the entire
  // live engine sat fully disconnected (status: "disconnected", no prices, no signals)
  // for as long as all 60 pair/timeframe REST calls took -- a real, measured startup
  // cost on every cold boot/redeploy. Seeding is backfill for the candle store, not a
  // prerequisite for being connected: API routes and the signal engine already tolerate
  // an empty store until live ticks or this seeding fills it in naturally (see
  // seedHistoricalCandles' own doc comment). Running it concurrently with connect()
  // instead means the two no longer add together -- total time is whichever is slower,
  // not both. Never allowed to abort the connection -- seedHistoricalCandles already
  // catches its own per-symbol failures, but this .catch() is defense in depth against
  // a more systemic seeding failure (e.g. MetaApi's market-data API itself unreachable
  // at boot) also taking down the streaming connection, which is the actually critical
  // piece (real-time prices, candles, and the ability to execute at all). A confirmed
  // real incident: one transient 504 here previously left the live engine fully
  // disconnected until the next redeploy, since ensureMetaApiConnection is only ever
  // attempted once at boot.
  if (accountKey === "live") {
    void seedHistoricalCandles(account).catch((error: unknown) => {
      console.error("[market] historical candle seeding failed entirely (live streaming unaffected):", error);
    });
  }

  const connection = account.getStreamingConnection();
  connection.addSynchronizationListener(new MarketSyncListener(accountKey, accountKey === "live" ? connection : undefined));

  await connection.connect();
  await connection.waitSynchronized();

  // A terminal that once had more symbols subscribed -- e.g. the 2026-08-28 PAIRS
  // widen-then-revert (see types.ts's own doc comment on that incident) -- keeps
  // trying to maintain those stale subscriptions across every reconnect even after
  // this app stops requesting them, since MetaApi's terminal-side state persists
  // independently of what subscribeToMarketData asks for going forward. Confirmed as
  // a real, separate recurrence of the same downgrade storm hours after PAIRS was
  // already back to 9 -- no PAIRS change fired that time, and the symbols downgrading
  // (XAGUSDm, ETHUSDm) were exactly the ones the earlier widen had added and never
  // explicitly released. Explicitly unsubscribing anything the terminal reports beyond
  // today's PAIRS clears this permanently, instead of relying on a manual pause/
  // redeploy on app.metaapi.cloud every time this recurs. Same 6.5s stagger as the
  // subscribe loop below -- unsubscribeFromMarketData shares the same 10-calls/60s
  // account-level rate limit.
  //
  // Deliberately NOT limited to connection.subscribedSymbols -- confirmed by a real
  // production log that it doesn't cover this case: it's this SDK CLIENT's own local
  // subscription cache, so a brand-new connection instance (e.g. right after a
  // redeploy) starts with it empty and never sees a ghost symbol the client itself
  // never called subscribeToMarketData for this session, even though the ACCOUNT's own
  // server-side terminal state still has it and keeps emitting real downgrade events
  // for it. Unioned with every Pair the type union has ever named (ALL_PAIRS) minus
  // today's PAIRS instead, so a historically-widened-then-reverted symbol always gets a
  // real unsubscribe attempt regardless of what the client-side cache happens to know.
  const wantedSymbols = new Set(PAIRS.map(brokerSymbol));
  const historicallyStale = ALL_PAIRS.filter((pair) => !PAIRS.includes(pair)).map(brokerSymbol);
  const staleSymbols = [...new Set([...connection.subscribedSymbols.filter((symbol) => !wantedSymbols.has(symbol)), ...historicallyStale])];
  for (const [index, symbol] of staleSymbols.entries()) {
    if (isSuperseded()) {
      console.log(`[market] ${accountKey} connect() attempt superseded by a newer one -- abandoning mid stale-unsubscribe`);
      // Fire-and-forget, deliberately not awaited -- this attempt is already being
      // abandoned specifically because it's been slow/stuck, so blocking its own return
      // on close() settling would defeat the point of superseding it in the first place.
      void connection.close().catch(() => {});
      return;
    }
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_STAGGER_MS));
    try {
      await connection.unsubscribeFromMarketData(symbol, [{ type: "quotes" }, { type: "candles" }]);
      console.log(`[market] ${accountKey} unsubscribed stale symbol ${symbol}`);
    } catch (error: unknown) {
      console.error(`[market] ${accountKey} failed to unsubscribe stale symbol ${symbol}:`, error);
    }
  }
  if (staleSymbols.length > 0) await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_STAGGER_MS));

  for (const [index, pair] of PAIRS.entries()) {
    if (isSuperseded()) {
      console.log(`[market] ${accountKey} connect() attempt superseded by a newer one -- abandoning mid pair-subscribe`);
      void connection.close().catch(() => {});
      return;
    }
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_STAGGER_MS));
    await connection.subscribeToMarketData(
      brokerSymbol(pair),
      // "demo" only ever needs quotes -- enough for terminalState.accountInformation/
      // specification/positions, never candles (it's purely an execution target, no
      // second signal engine, see MarketSyncListener's own doc comment above).
      accountKey === "live" ? LIVE_MARKET_DATA_SUBSCRIPTIONS : [{ type: "quotes" }]
    );
  }

  // Final guard, in case this attempt was superseded right after the last loop check
  // passed -- must never let a stale, abandoned connection clobber a fresher one that
  // already finished and is streaming real data.
  if (isSuperseded()) {
    console.log(`[market] ${accountKey} connect() attempt superseded by a newer one -- discarding the connection it just finished building`);
    void connection.close().catch(() => {});
    return;
  }

  const state = stateFor(accountKey);
  state.connection = connection;
  state.account = account;
  console.log(`[market] ${accountKey} account connected and streaming ${PAIRS.join(", ")}`);
}

// --- Broker accessors (execution engine + API routes read through these, never the SDK directly) ---

export type ConnectionStatus = "live" | "reconnecting" | "disconnected";

/**
 * "live" requires the full chain to be healthy: MetaApi's own sync finished, MetaApi is
 * connected to the MT5 terminal, and that terminal is itself connected to the broker.
 * Any one of those being false means data could be stale even though the process is
 * technically still running -- "reconnecting" covers all of those cases without trying
 * to distinguish which specific link dropped.
 */
export function getConnectionStatus(accountKey: AccountKey = "live"): { status: ConnectionStatus; lastUpdateAt: number | null } {
  const state = stateFor(accountKey);
  const connection = state.connection;
  if (!connection) return { status: "disconnected", lastUpdateAt: state.lastUpdateAt };

  const healthy = connection.synchronized && connection.terminalState.connected && connection.terminalState.connectedToBroker;
  return { status: healthy ? "live" : "reconnecting", lastUpdateAt: state.lastUpdateAt };
}

/**
 * On-demand REST fetch, not a live subscription -- used by the M5 entry-confirmation
 * gate (see onCandlesUpdated below and m5Confirmation.ts). Deliberately NOT a live
 * candle stream: M5 was dropped from the permanent subscriptions earlier for exactly
 * this reason (see connect()'s own comment above) after it caused MetaApi to rate-limit
 * other pairs' candle subscriptions. Calling this only at the rare moment a candidate
 * signal is about to fire, never on every tick, avoids that entirely. Reuses the same
 * getHistoricalCandles REST call and candle-mapping shape seedHistory.ts already uses
 * for the initial history seed, just a small bar count instead of a full backfill.
 * Never throws -- returns [] on any failure so a fetch hiccup just reads as "not
 * confirmed" (see confirmsDirection's own fail-closed doc comment), not a crash.
 */
export async function fetchRecentCandles(pair: Pair, timeframe: Timeframe, barCount: number, accountKey: AccountKey = "live"): Promise<Candle[]> {
  const account = stateFor(accountKey).account;
  if (!account) return [];
  try {
    const raw = await account.getHistoricalCandles(brokerSymbol(pair), timeframe, new Date(), barCount);
    return raw.map((c) => ({ time: c.time.getTime(), open: c.open, high: c.high, low: c.low, close: c.close, tickVolume: c.tickVolume }));
  } catch (error) {
    console.error(`[market] on-demand ${timeframe} candle fetch failed for ${pair}:`, error);
    return [];
  }
}

export function getAccountInformation(accountKey: AccountKey = "live"): AccountInfo | undefined {
  const info = stateFor(accountKey).connection?.terminalState.accountInformation;
  if (!info) return undefined;
  return { balance: info.balance, equity: info.equity, freeMargin: info.freeMargin, margin: info.margin, tradeAllowed: info.tradeAllowed };
}

/** Per-symbol trading permission/constraint, separate from getSymbolSpecification
 * (which feeds computeLotSize's sizing-critical math) so the System Health panel's own
 * needs never touch that sizing-relevant type. Same cached terminalState.specification()
 * read -- no new network call. */
export function getSymbolTradingInfo(pair: Pair, accountKey: AccountKey = "live"): { tradeMode: string | undefined; stopsLevel: number } | undefined {
  const spec = stateFor(accountKey).connection?.terminalState.specification(brokerSymbol(pair));
  if (!spec) return undefined;
  return { tradeMode: spec.tradeMode, stopsLevel: spec.stopsLevel };
}

/** Total open positions on the account, including any not opened by this app — used for
 * risk limits. Excludes a position mid-close from a fresh invalidation exit (see
 * pendingInvalidationClose.ts) — this is MetaApi's own live broker state, which won't
 * reflect that close until the broker actually processes it, and this is the only
 * caller of this function (executionEngine.ts's maxConcurrentPositions check), so the
 * exclusion can't mislead any other reader of "how many positions are open right now"
 * (getOpenPositions below is unaffected, deliberately). */
export function getOpenPositionCount(accountKey: AccountKey = "live"): number {
  const positions = stateFor(accountKey).connection?.terminalState.positions ?? [];
  return positions.filter((p) => !isPending(String(p.id))).length;
}

/** Open positions mapped to our tracked pairs only (skips symbols outside PAIRS, e.g. opened manually). */
export function getOpenPositions(accountKey: AccountKey = "live"): OpenPosition[] {
  const positions = stateFor(accountKey).connection?.terminalState.positions ?? [];
  const result: OpenPosition[] = [];
  for (const raw of positions) {
    const pair = pairForBrokerSymbol(raw.symbol);
    if (!pair) continue;
    result.push({
      id: String(raw.id),
      pair,
      direction: raw.type === "POSITION_TYPE_BUY" ? "long" : "short",
      lots: raw.volume,
      openPrice: raw.openPrice,
      currentPrice: raw.currentPrice,
      stopLoss: raw.stopLoss,
      takeProfit: raw.takeProfit,
      profit: raw.profit,
      clientId: raw.clientId,
    });
  }
  return result;
}

export function getSymbolSpecification(pair: Pair, accountKey: AccountKey = "live"): SymbolSpec | undefined {
  const spec = stateFor(accountKey).connection?.terminalState.specification(brokerSymbol(pair));
  if (!spec) return undefined;
  return { contractSize: spec.contractSize, volumeStep: spec.volumeStep, volumeMin: spec.minVolume, volumeMax: spec.maxVolume, point: spec.point };
}

export type PlaceOrderResult =
  | { success: true; filledEntry: number; brokerPositionId?: string; brokerOrderId?: string }
  | { success: false; numericCode?: number; stringCode?: string; message: string };

// Response codes that indicate success, per MetatraderTradeResponse.numericCode's docs.
const TRADE_SUCCESS_CODES = new Set([0, 10008, 10009, 10010, 10025]);

export async function placeMarketOrder(
  pair: Pair,
  direction: "long" | "short",
  lots: number,
  stopLoss: number,
  takeProfit: number,
  requestedEntry: number,
  accountKey: AccountKey = "live"
): Promise<PlaceOrderResult> {
  const connection = stateFor(accountKey).connection;
  if (!connection) return { success: false, message: `no active MetaApi connection (${accountKey})` };
  const symbol = brokerSymbol(pair);
  // Shows up as the position's comment in MT5 itself, so a trade is identifiable
  // in the broker terminal, not just on the dashboard.
  const comment = direction === "long" ? "JUDE" : "OMINI";

  // No clientId -- confirmed in production (a real, repeated "Validation failed...
  // clientId... must match required pattern" rejection from MetaApi) that it validates
  // clientId against an undocumented pattern neither a flat hex string nor an
  // underscore-prefixed one satisfied. It's optional (this app's own idempotency guard,
  // positionStore.hasExecuted() checked synchronously before this call ever runs, is the
  // real, primary protection against a duplicate order -- clientId was only ever
  // defense-in-depth on top of that), so rather than keep guessing at an unpublished
  // regex, this simply stops sending the one field that kept getting every order
  // rejected outright.
  let response: MetatraderTradeResponse;
  try {
    response =
      direction === "long"
        ? await connection.createMarketBuyOrder(symbol, lots, stopLoss, takeProfit, { comment })
        : await connection.createMarketSellOrder(symbol, lots, stopLoss, takeProfit, { comment });
  } catch (error) {
    // MetaApi's SDK throws (rather than returning a normal response) for a validation-
    // level rejection, and its own Error.message alone is often just "Validation failed
    // (<trace id>)" with no real detail -- but the thrown object frequently carries
    // additional properties (details/numericCode/stringCode/trace id) the SDK attaches
    // beyond the base Error shape. Logged in full here (server-side only, never returned
    // to the client) so a genuinely opaque rejection like that has an actual diagnosable
    // reason in the logs next time, instead of only the same bare trace id every time.
    console.error(`[metaapi] createMarket${direction === "long" ? "Buy" : "Sell"}Order threw for ${symbol} (${accountKey}):`, {
      error,
      errorKeys: error && typeof error === "object" ? Object.keys(error) : undefined,
      errorJson: (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return undefined;
        }
      })(),
      lots,
      stopLoss,
      takeProfit,
      requestedEntry,
    });
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!TRADE_SUCCESS_CODES.has(response.numericCode)) {
    return { success: false, numericCode: response.numericCode, stringCode: response.stringCode, message: response.message };
  }

  // The trade response doesn't carry the actual fill price — read it back from the
  // now-open position if the local terminal state has already synced it, falling back
  // to the requested price (which was the current ask/bid at signal time) otherwise.
  const openedPosition = connection.terminalState.positions.find((p) => p.id === Number(response.positionId));
  return {
    success: true,
    filledEntry: openedPosition?.openPrice ?? requestedEntry,
    brokerPositionId: response.positionId,
    brokerOrderId: response.orderId,
  };
}

export type ModifyPositionResult = { success: true } | { success: false; numericCode?: number; stringCode?: string; message: string };

export interface ModifyPositionInput {
  stopLoss?: number;
  takeProfit?: number;
  trailingStopLoss?: TrailingStopLoss;
}

/**
 * Used by positionManager.ts for break-even moves and arming a trailing stop -- never
 * called anywhere else. Mirrors placeMarketOrder's own shape: never throws on a
 * broker-level rejection (e.g. a position that already closed a moment earlier), only on
 * a genuine transport-level exception, so a poller iterating many positions can log one
 * failure and keep going rather than crash the whole cycle.
 */
export async function modifyPosition(positionId: string, input: ModifyPositionInput, accountKey: AccountKey = "live"): Promise<ModifyPositionResult> {
  const connection = stateFor(accountKey).connection;
  if (!connection) return { success: false, message: `no active MetaApi connection (${accountKey})` };

  let response: MetatraderTradeResponse;
  try {
    response = await connection.modifyPosition(positionId, input.stopLoss, input.takeProfit, input.trailingStopLoss);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!TRADE_SUCCESS_CODES.has(response.numericCode)) {
    return { success: false, numericCode: response.numericCode, stringCode: response.stringCode, message: response.message };
  }
  return { success: true };
}

/**
 * Used by positionInvalidation.ts's early-exit path -- never called anywhere else. Same
 * non-throwing-on-broker-rejection posture as modifyPosition/placeMarketOrder above.
 */
export async function closePosition(positionId: string, accountKey: AccountKey = "live"): Promise<ModifyPositionResult> {
  const connection = stateFor(accountKey).connection;
  if (!connection) return { success: false, message: `no active MetaApi connection (${accountKey})` };

  let response: MetatraderTradeResponse;
  try {
    response = await connection.closePosition(positionId, {});
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!TRADE_SUCCESS_CODES.has(response.numericCode)) {
    return { success: false, numericCode: response.numericCode, stringCode: response.stringCode, message: response.message };
  }
  return { success: true };
}

/**
 * Used by positionManager.ts's partial take-profit action (see evaluatePositionForManagement)
 * -- never called anywhere else. Same non-throwing-on-broker-rejection posture as
 * closePosition/modifyPosition above; the position itself stays open at the reduced
 * volume afterward (this is not a full close), which is exactly why partial closes are
 * deliberately kept out of the trade journal entirely -- see positionManager.ts's own
 * doc comment on that decision.
 */
export async function closePositionPartially(positionId: string, volume: number, accountKey: AccountKey = "live"): Promise<ModifyPositionResult> {
  const connection = stateFor(accountKey).connection;
  if (!connection) return { success: false, message: `no active MetaApi connection (${accountKey})` };

  let response: MetatraderTradeResponse;
  try {
    response = await connection.closePositionPartially(positionId, volume, {});
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!TRADE_SUCCESS_CODES.has(response.numericCode)) {
    return { success: false, numericCode: response.numericCode, stringCode: response.stringCode, message: response.message };
  }
  return { success: true };
}

/**
 * The "Close All Positions" emergency action -- loops the existing single-position
 * closePosition wrapper above, no new broker logic. Closes are attempted serially (not
 * Promise.all), matching this file's existing single-account/serial-call posture
 * elsewhere (seedHistory.ts, historyLoader.ts) -- a broker rejecting one close due to a
 * transient error shouldn't race against others closing concurrently. A failure on one
 * position never stops the rest from being attempted.
 */
export async function closeAllPositions(accountKey: AccountKey = "live"): Promise<{ closed: string[]; failed: { id: string; reason: string }[] }> {
  const closed: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const position of getOpenPositions(accountKey)) {
    const result = await closePosition(position.id, accountKey);
    if (result.success) closed.push(position.id);
    else failed.push({ id: position.id, reason: result.message });
  }

  return { closed, failed };
}

const connectPromisesKey = Symbol.for("forex-ai.metaApiConnection.connectPromises");
type GlobalWithConnectPromises = typeof globalThis & { [connectPromisesKey]?: Map<AccountKey, Promise<void>> };
const g = globalThis as GlobalWithConnectPromises;
const connectPromises: Map<AccountKey, Promise<void>> = g[connectPromisesKey] ?? (g[connectPromisesKey] = new Map());

/** Idempotent per account: the first caller for a given account starts that account's
 * connection, later callers (for the same account) get the same promise. */
export function ensureMetaApiConnection(accountKey: AccountKey = "live"): Promise<void> {
  let promise = connectPromises.get(accountKey);
  if (!promise) {
    promise = connect(accountKey);
    connectPromises.set(accountKey, promise);
  }
  return promise;
}

const FORCE_RECONNECT_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

/**
 * Recovery path for the resync-loop failure mode seen repeatedly in production: the SDK
 * gets stuck endlessly resynchronizing without ever completing, and nothing in this app
 * previously re-attempted a connection after boot -- ensureMetaApiConnection's cached
 * promise means a plain retry there is a no-op, and StreamingMetaApiConnectionInstance's
 * own connect() is documented as one-shot ("next calls will be ignored"). The only fix
 * that has ever actually cleared this tonight was a full process redeploy (a fresh
 * globalThis heap forcing connect() to genuinely rerun). This reproduces that same
 * "genuinely fresh connection" outcome without a real process restart: close() the
 * stuck instance (best-effort, time-boxed -- a truly wedged connection might not even
 * respond to close()) and rebuild via connect() below, which constructs an entirely new
 * MetaApi/account/connection object graph. Called by connectionWatchdog.ts once a
 * connection has been unhealthy long enough that it's very unlikely to self-recover.
 */
export async function forceReconnect(accountKey: AccountKey): Promise<void> {
  const state = stateFor(accountKey);
  const stale = state.connection;
  // Fail closed immediately, before the rebuild even starts -- getConnectionStatus must
  // read "disconnected" while this is in flight, never a falsely-healthy stale read off
  // the connection object we're about to discard.
  state.connection = null;

  if (stale) {
    try {
      await withTimeout(stale.close(), FORCE_RECONNECT_TIMEOUT_MS, `${accountKey} stale connection close()`);
    } catch (error) {
      console.error(`[market] error closing stale ${accountKey} connection during forced reconnect (continuing anyway):`, error);
    }
  }

  const fresh = connect(accountKey);
  connectPromises.set(accountKey, fresh);
  await fresh;
}
