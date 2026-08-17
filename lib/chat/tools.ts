import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { predictionStore } from "../market/predictionStore";
import { signalStore } from "../market/signalStore";
import { getEngineMode, manualExecutionAccount, LIVE_CONFIRMATION_PHRASE } from "../market/engineMode";
import { loadExecutionConfig } from "../market/executionConfig";
import { getAccountInformation, getOpenPositions, isAccountConfigured } from "../market/metaApiConnection";
import { positionStore } from "../market/positionStore";
import { riskState } from "../market/riskState";
import { describeNoTradeReason } from "../market/noTradeReason";
import { predictionHeadline, predictionSubline } from "../market/predictionLabel";
import { scoreSetupQuality } from "../market/setupQualityScore";
import { getPerformanceStats, tradeJournal, type PerformanceFilter } from "../market/tradeJournal";
import { buildConfirmPhrase, buildResultAnnouncement, normalize } from "../voice/grammar";
import type { ExecuteResponse } from "../market/executionClient";
import { PAIRS, type MarketRegime, type Pair, type Session, type Timeframe } from "../market/types";

function dayKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];
const SESSIONS: Session[] = ["asia", "london", "newyork", "off-session"];
const REGIMES: MarketRegime[] = [
  "news_driven",
  "breakout",
  "strong_uptrend",
  "strong_downtrend",
  "high_volatility",
  "low_volatility",
  "consolidation",
  "range",
];

// The model's tool-call arguments are free-text strings, not guaranteed to be one of
// this app's real enum values -- validated the same way the /api/trade-journal route
// validates its own query params, rather than an unchecked cast. An unrecognized value
// is simply dropped from the filter (never guessed into the nearest real one).
function tradeJournalFilterFrom(input: { pair?: string; timeframe?: string; session?: string; regime?: string; signerBAgreement?: boolean }): PerformanceFilter {
  const filter: PerformanceFilter = {};
  if (input.pair && PAIRS.includes(input.pair as Pair)) filter.pair = input.pair as Pair;
  if (input.timeframe && TIMEFRAMES.includes(input.timeframe as Timeframe)) filter.timeframe = input.timeframe as Timeframe;
  if (input.session && SESSIONS.includes(input.session as Session)) filter.session = input.session as Session;
  if (input.regime && REGIMES.includes(input.regime as MarketRegime)) filter.regime = input.regime as MarketRegime;
  if (input.signerBAgreement !== undefined) filter.signerBAgreement = input.signerBAgreement;
  return filter;
}

/**
 * Makes a real HTTP request back into this same running server, forwarding the same
 * Authorization header the incoming /api/chat request carried. This is deliberate, not
 * an accident of convenience: engineMode.ts's enableLiveMode() is documented as "MUST
 * NEVER be called from anywhere except the POST /api/engine-mode route handler" -- so
 * rather than importing and calling it (or setEngineMode/the kill-switch file writes)
 * directly from chat code, every state-changing action goes through the app's own
 * existing REST route, exactly as a manual dashboard click would. Those functions remain,
 * literally, only ever called from within their one existing route handler.
 */
async function callOwnApi(
  origin: string,
  authHeader: string | null,
  path: string,
  init: { method: string; body?: unknown }
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authHeader) headers.authorization = authHeader;
  const response = await fetch(`${origin}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

export interface ToolContext {
  /** The raw, unmodified text of the user's current chat message -- read by the
   * confirm-phrase gates below. Never derived from anything the LLM produced. */
  rawUserMessage: string;
  /** Origin (protocol+host) of the running server, for self-referential API calls. */
  origin: string;
  /** The incoming /api/chat request's own Authorization header, forwarded unchanged so
   * self-calls pass the same proxy.ts auth check the original request already passed. */
  authHeader: string | null;
}

/**
 * Builds this turn's tool set fresh, closed over the current turn's raw user message.
 * Tool inputs are LLM-controlled and therefore untrusted for anything safety-relevant --
 * execute_trade and set_engine_mode("live") never accept a confirmation phrase or
 * boolean as an argument; they check ctx.rawUserMessage themselves, independently of
 * whatever the model's tool call claims.
 */
export function buildTools(ctx: ToolContext) {
  const get_predictions = betaZodTool({
    name: "get_predictions",
    description:
      "Get the current SMC signal engine evaluation for every watched pair -- headline (e.g. STRONG BUY, NEUTRAL, NO TRADE), a short reason, and confidence. Use this to answer any question about current market read/outlook.",
    inputSchema: z.object({}),
    run: async () => {
      const updates = predictionStore.all();
      return JSON.stringify(
        updates.map((update) => ({
          pair: update.pair,
          timeframe: update.timeframe,
          headline: predictionHeadline(update.evaluation),
          regime: update.regime,
          detail:
            update.evaluation.status === "no_trade"
              ? describeNoTradeReason(update.evaluation.reason)
              : predictionSubline(update.evaluation),
          time: update.time,
        }))
      );
    },
  });

  const get_signals = betaZodTool({
    name: "get_signals",
    description:
      "List recent executable trade signals (buy/strong_buy tier, not watch-tier) with their id, pair, direction, entry/stop-loss/take-profit, confidence, a full breakdown of what confirmed the setup (SMC's own direction/entry sub-scores and confluence tags, plus Signer B's independent direction/confidence and its own EMA trend/Supertrend/RSI divergence/currency strength/news reads), the current market regime for that pair/timeframe, a transparent 7-category setup quality breakdown (NOT a win probability), and the exact confirmation phrase required to execute each one. Use this before proposing a trade, answering 'what should I trade', or explaining 'why did you buy/sell X' or 'why is this setup only scored N'.",
    inputSchema: z.object({}),
    run: async () => {
      return JSON.stringify(
        signalStore
          .all()
          .filter((signal) => signal.tier !== "watch")
          .map((signal) => {
            // TradingView-sourced signals carry hardcoded placeholder direction/entry
            // scores (see tradingViewWebhook.ts), never real SMC-derived ones -- a
            // regime read and quality breakdown off those would fabricate meaning
            // that isn't there, so both stay undefined for that source (same
            // exclusion SignerBBreakdown.tsx/SetupQualityBreakdown.tsx apply).
            const regime = signal.source === "tradingview" ? undefined : predictionStore.get(signal.pair, signal.timeframe, signal.source)?.regime;
            return {
              id: signal.id,
              pair: signal.pair,
              direction: signal.direction,
              entry: signal.entry,
              stopLoss: signal.stopLoss,
              takeProfit: signal.takeProfit,
              confidence: signal.confidence,
              tier: signal.tier,
              riskReward: signal.riskReward,
              directionScore: signal.directionScore,
              entryScore: signal.entryScore,
              adx: signal.adx,
              rsi: signal.rsi,
              signerBDirection: signal.signerBDirection,
              signerBConfidence: signal.signerBConfidence,
              confluences: signal.confluences,
              signerBEmaTrend: signal.signerBEmaTrend,
              supertrendTrend: signal.supertrendTrend,
              rsiDivergence: signal.rsiDivergence,
              usdStrengthStatus: signal.usdStrengthStatus,
              newsStatus: signal.newsStatus,
              regime: regime ?? "unavailable",
              setupQuality: regime ? scoreSetupQuality(signal, regime) : "unavailable",
              confirmPhraseRequiredToExecute: buildConfirmPhrase(signal),
            };
          })
      );
    },
  });

  const get_trade_journal = betaZodTool({
    name: "get_trade_journal",
    description:
      "Get real, closed-trade performance history for trades THIS app opened and closed -- count, win rate, average R-multiple, and max drawdown (in R), optionally filtered by pair/timeframe/session/regime/whether Signer B agreed with the trade's direction. This is the ONLY source of a real win rate or accuracy figure in this system -- always call this rather than estimating or recalling one from earlier in the conversation. An empty or low-count result is an honest 'not enough closed trades yet', not a sign of a broken system.",
    inputSchema: z.object({
      pair: z.string().optional().describe("Filter to one pair, e.g. 'EUR/USD'. Omit for all pairs."),
      timeframe: z.string().optional().describe("Filter to one timeframe, e.g. '15m'. Omit for all timeframes."),
      session: z.string().optional().describe("Filter to one session: asia, london, newyork, off-session."),
      regime: z.string().optional().describe("Filter to trades that fired during one market regime, e.g. 'strong_uptrend'."),
      signerBAgreement: z
        .boolean()
        .optional()
        .describe("true = only trades where Signer B agreed with the direction at signal time; false = only trades where it didn't."),
    }),
    run: async (input) => {
      const entries = tradeJournal.all();
      const stats = getPerformanceStats(entries, tradeJournalFilterFrom(input));
      return JSON.stringify({
        stats,
        recentEntries: entries.slice(0, 20).map((entry) => ({
          pair: entry.pair,
          direction: entry.direction,
          profit: entry.profit,
          rMultiple: entry.rMultiple,
          reason: entry.reason,
          closedAt: entry.closedAt,
          regime: entry.context?.regime ?? "unavailable",
        })),
      });
    },
  });

  const get_positions = betaZodTool({
    name: "get_positions",
    description:
      "Get currently open broker positions and today's trade count, for whichever account a manual trade action would currently target (same resolution the dashboard uses).",
    inputSchema: z.object({}),
    run: async () => {
      const accountKey = manualExecutionAccount(getEngineMode());
      return JSON.stringify({
        account: accountKey,
        positions: getOpenPositions(accountKey),
        tradesToday: positionStore.tradesOnDay(dayKeyFor(Date.now()), accountKey).length,
      });
    },
  });

  const get_risk_status = betaZodTool({
    name: "get_risk_status",
    description:
      "Get today's risk-guardian status: whether trading is halted for the day, any active cooldown, consecutive losses, and the configured limits. Use this before discussing whether a trade could execute right now.",
    inputSchema: z.object({}),
    run: async () => {
      const accountKey = manualExecutionAccount(getEngineMode());
      const config = loadExecutionConfig(accountKey);
      const account = getAccountInformation(accountKey);
      const now = Date.now();
      const dayState = account ? riskState.current(now, account.equity, accountKey) : null;
      return JSON.stringify({
        account: accountKey,
        haltedForToday: dayState?.haltedForToday ?? false,
        cooldownUntil: dayState?.cooldownUntil ?? null,
        consecutiveLosses: dayState?.consecutiveLosses ?? 0,
        maxConsecutiveLosses: config.maxConsecutiveLosses,
        maxDailyLossPct: config.maxDailyLossPct,
      });
    },
  });

  const get_engine_mode = betaZodTool({
    name: "get_engine_mode",
    description: "Get the current Autopilot engine mode (analysis, demo, or live) and whether demo is configured.",
    inputSchema: z.object({}),
    run: async () => {
      const mode = getEngineMode();
      return JSON.stringify({
        mode,
        demoConfigured: isAccountConfigured("demo"),
        riskPerTradePct: loadExecutionConfig(manualExecutionAccount(mode)).riskPerTradePct,
      });
    },
  });

  const pause_trading = betaZodTool({
    name: "pause_trading",
    description: "Pause auto-execution (kill switch ON) for an account. No confirmation phrase needed -- pausing is always the safe direction.",
    inputSchema: z.object({ account: z.enum(["live", "demo"]).default("live") }),
    run: async (input) => {
      const { status, json } = await callOwnApi(ctx.origin, ctx.authHeader, "/api/kill-switch", {
        method: "POST",
        body: { action: "pause", account: input.account },
      });
      return JSON.stringify({ status, result: json });
    },
  });

  const resume_trading = betaZodTool({
    name: "resume_trading",
    description:
      "Resume auto-execution (kill switch OFF) for an account. This re-arms auto-trading -- only call this when the user has clearly asked to resume, not as a side effect of another request.",
    inputSchema: z.object({ account: z.enum(["live", "demo"]).default("live") }),
    run: async (input) => {
      const { status, json } = await callOwnApi(ctx.origin, ctx.authHeader, "/api/kill-switch", {
        method: "POST",
        body: { action: "resume", account: input.account },
      });
      return JSON.stringify({ status, result: json });
    },
  });

  const set_engine_mode = betaZodTool({
    name: "set_engine_mode",
    description:
      "Switch the Autopilot engine mode. 'analysis' and 'demo' apply immediately, no confirmation needed. 'live' enables real-money auto-execution and REQUIRES the user to have typed or said the exact phrase 'ENABLE LIVE TRADING' as their own message -- if they have not, this tool refuses and tells you the exact phrase to relay back to them. Never claim live mode is enabled unless this tool's result says ok:true.",
    inputSchema: z.object({ mode: z.enum(["analysis", "demo", "live"]) }),
    run: async (input) => {
      if (input.mode === "live") {
        // Independent, tool-side check against the RAW user message -- never the LLM's
        // own claim -- mirroring exactly how parseVoiceCommand only ever recognizes
        // hard_confirm on an exact match. enableLiveMode() re-checks this again itself
        // once the request reaches /api/engine-mode, so this is defense in depth, not
        // the only gate.
        if (normalize(ctx.rawUserMessage) !== normalize(LIVE_CONFIRMATION_PHRASE)) {
          return JSON.stringify({
            ok: false,
            error: "confirmation_required",
            message: `The user has not yet typed or said the exact phrase "${LIVE_CONFIRMATION_PHRASE}". Ask them to state it exactly, then retry -- do not enable live mode without it.`,
          });
        }
      }
      const { status, json } = await callOwnApi(ctx.origin, ctx.authHeader, "/api/engine-mode", {
        method: "POST",
        body: { mode: input.mode, confirmationPhrase: ctx.rawUserMessage },
      });
      return JSON.stringify({ status, result: json });
    },
  });

  const execute_trade = betaZodTool({
    name: "execute_trade",
    description:
      "Execute a specific trade signal by id. REQUIRES the user to have typed or said the exact confirmation phrase for that signal (from get_signals' confirmPhraseRequiredToExecute, e.g. 'CONFIRM BUY EURUSD') as their own message -- if they have not, this tool refuses and tells you the exact phrase to relay back to them. Never claim a trade was placed unless this tool's result says status:'filled'.",
    inputSchema: z.object({ signalId: z.string() }),
    run: async (input) => {
      const signal = signalStore.get(input.signalId);
      if (!signal) {
        return JSON.stringify({ ok: false, error: "not_found", message: "That signal id was not found or has expired." });
      }

      const requiredPhrase = buildConfirmPhrase(signal);
      // Same independent, tool-side raw-message check as set_engine_mode above -- the
      // model's tool call arguments are never trusted as proof of confirmation.
      if (normalize(ctx.rawUserMessage) !== normalize(requiredPhrase)) {
        return JSON.stringify({
          ok: false,
          error: "confirmation_required",
          message: `The user has not yet typed or said the exact phrase "${requiredPhrase}". Ask them to state it exactly, then retry -- do not execute without it.`,
        });
      }

      const { json } = await callOwnApi(ctx.origin, ctx.authHeader, `/api/signals/${input.signalId}/execute`, {
        method: "POST",
        // The execute route now requires this itself (confirmationMode.ts's gate) --
        // already computed and verified above against the user's own raw message, so
        // this just forwards the exact same phrase, not a second independent check.
        body: { confirmationPhrase: requiredPhrase },
      });
      const result = json as ExecuteResponse;
      return JSON.stringify({ ok: true, result, spoken: buildResultAnnouncement(signal, result) });
    },
  });

  return [
    get_predictions,
    get_signals,
    get_positions,
    get_risk_status,
    get_engine_mode,
    get_trade_journal,
    pause_trading,
    resume_trading,
    set_engine_mode,
    execute_trade,
  ];
}
