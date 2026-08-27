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
import { getPerformanceBreakdown, getPerformanceStats, tradeJournal, type PerformanceFilter } from "../market/tradeJournal";
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

// The model's tool-call arguments are an untrusted, loosely-typed JSON object -- not
// guaranteed to be one of this app's real enum values or even the right JS type -- so
// every field is typeof-checked before use, same discipline the /api/trade-journal route
// already applies to its own query params. An unrecognized/wrong-typed value is simply
// dropped from the filter (never guessed into the nearest real one).
function tradeJournalFilterFrom(input: Record<string, unknown>): PerformanceFilter {
  const filter: PerformanceFilter = {};
  if (typeof input.pair === "string" && PAIRS.includes(input.pair as Pair)) filter.pair = input.pair as Pair;
  if (typeof input.timeframe === "string" && TIMEFRAMES.includes(input.timeframe as Timeframe)) filter.timeframe = input.timeframe as Timeframe;
  if (typeof input.session === "string" && SESSIONS.includes(input.session as Session)) filter.session = input.session as Session;
  if (typeof input.regime === "string" && REGIMES.includes(input.regime as MarketRegime)) filter.regime = input.regime as MarketRegime;
  if (typeof input.signerBAgreement === "boolean") filter.signerBAgreement = input.signerBAgreement;
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

/** A plain, provider-agnostic tool definition -- `parameters` is a raw JSON Schema object
 * (not a Zod schema tied to one SDK's own conversion), so the same definitions work
 * whichever model provider is wired up in engine.ts. `run` always receives a loosely-typed
 * args object (the model's own JSON output, never guaranteed to match `parameters`) and is
 * responsible for validating it defensively -- see tradeJournalFilterFrom above for the
 * pattern every tool below follows. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const NO_PARAMS = { type: "object", properties: {} } as const;

/**
 * Builds this turn's tool set fresh, closed over the current turn's raw user message.
 * Tool inputs are LLM-controlled and therefore untrusted for anything safety-relevant --
 * execute_trade and set_engine_mode("live") never accept a confirmation phrase or
 * boolean as an argument; they check ctx.rawUserMessage themselves, independently of
 * whatever the model's tool call claims.
 */
export function buildTools(ctx: ToolContext): ToolDef[] {
  const get_predictions: ToolDef = {
    name: "get_predictions",
    description:
      "Get the current evaluation for every watched pair from BOTH signal engines -- SMC (source \"smc\", trend-continuation setups) and the Range Engine (source \"mean_reversion\", mean-reversion/range-bounce setups) -- headline (e.g. STRONG BUY, NEUTRAL, NO TRADE), a short reason, and confidence. Each pair+timeframe appears twice, once per engine, distinguished by the `source` field -- always check it before answering an engine-specific question (e.g. \"what about the range setup\") rather than defaulting to SMC. Use this to answer any question about current market read/outlook.",
    parameters: NO_PARAMS,
    run: async () => {
      const updates = predictionStore.all();
      return JSON.stringify(
        updates.map((update) => ({
          pair: update.pair,
          timeframe: update.timeframe,
          source: update.source,
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
  };

  const get_signals: ToolDef = {
    name: "get_signals",
    description:
      "List recent executable trade signals (buy/strong_buy tier, not watch-tier) from ANY engine -- check the `source` field (\"smc\", \"mean_reversion\" [the Range Engine], or \"tradingview\") before describing one, never assume SMC by default. Each entry has its id, pair, direction, entry/stop-loss/take-profit, confidence, a full breakdown of what confirmed the setup (SMC's own direction/entry sub-scores and confluence tags, plus Signer B's independent direction/confidence and its own EMA trend/Supertrend/RSI divergence/currency strength/news reads -- Signer B fields read \"unavailable\" for mean_reversion/tradingview signals, which don't use it, say so plainly rather than implying agreement), the current market regime for that pair/timeframe, a transparent setup quality breakdown (NOT a win probability), and the exact confirmation phrase required to execute each one. Use this before proposing a trade, answering 'what should I trade', or explaining 'why did you buy/sell X' or 'why is this setup only scored N'.",
    parameters: NO_PARAMS,
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
              source: signal.source,
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
  };

  const get_trade_journal: ToolDef = {
    name: "get_trade_journal",
    description:
      "Get real, closed-trade performance history for trades THIS app opened and closed -- count, win rate, average R-multiple, profit factor, and max drawdown (in R), optionally filtered by pair/timeframe/session/regime/whether Signer B agreed with the trade's direction. Also returns byEngine, a head-to-head stats breakdown for the SMC engine vs. the mean-reversion range engine -- use this whenever asked which engine is actually performing better, rather than guessing from recentEntries alone. This is the ONLY source of a real win rate or accuracy figure in this system -- always call this rather than estimating or recalling one from earlier in the conversation. An empty or low-count result is an honest 'not enough closed trades yet', not a sign of a broken system.",
    parameters: {
      type: "object",
      properties: {
        pair: { type: "string", description: "Filter to one pair, e.g. 'EUR/USD'. Omit for all pairs." },
        timeframe: { type: "string", description: "Filter to one timeframe, e.g. '15m'. Omit for all timeframes." },
        session: { type: "string", description: "Filter to one session: asia, london, newyork, off-session." },
        regime: { type: "string", description: "Filter to trades that fired during one market regime, e.g. 'strong_uptrend'." },
        signerBAgreement: {
          type: "boolean",
          description: "true = only trades where Signer B agreed with the direction at signal time; false = only trades where it didn't.",
        },
      },
    },
    run: async (input) => {
      const entries = tradeJournal.all();
      const stats = getPerformanceStats(entries, tradeJournalFilterFrom(input));
      return JSON.stringify({
        stats,
        // Always over the full unfiltered ledger, same reasoning as
        // /api/trade-journal's own breakdownBySource -- the point is comparing engines
        // against each other, not viewing one pre-filtered by the `input` args above.
        byEngine: getPerformanceBreakdown(entries, "source"),
        recentEntries: entries.slice(0, 20).map((entry) => ({
          pair: entry.pair,
          direction: entry.direction,
          profit: entry.profit,
          rMultiple: entry.rMultiple,
          reason: entry.reason,
          closedAt: entry.closedAt,
          regime: entry.context?.regime ?? "unavailable",
          source: entry.context?.source ?? "unavailable",
        })),
      });
    },
  };

  const get_positions: ToolDef = {
    name: "get_positions",
    description:
      "Get currently open broker positions and today's trade count, for whichever account a manual trade action would currently target (same resolution the dashboard uses).",
    parameters: NO_PARAMS,
    run: async () => {
      const accountKey = manualExecutionAccount(getEngineMode());
      return JSON.stringify({
        account: accountKey,
        positions: getOpenPositions(accountKey),
        tradesToday: positionStore.tradesOnDay(dayKeyFor(Date.now()), accountKey).length,
      });
    },
  };

  const get_risk_status: ToolDef = {
    name: "get_risk_status",
    description:
      "Get today's risk-guardian status: whether trading is halted for the day, any active cooldown, consecutive losses, and the configured limits. Use this before discussing whether a trade could execute right now.",
    parameters: NO_PARAMS,
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
  };

  const get_engine_mode: ToolDef = {
    name: "get_engine_mode",
    description: "Get the current Autopilot engine mode (analysis, demo, or live) and whether demo is configured.",
    parameters: NO_PARAMS,
    run: async () => {
      const mode = getEngineMode();
      return JSON.stringify({
        mode,
        demoConfigured: isAccountConfigured("demo"),
        riskPerTradePct: loadExecutionConfig(manualExecutionAccount(mode)).riskPerTradePct,
      });
    },
  };

  const accountParam = (input: Record<string, unknown>): "live" | "demo" => (input.account === "demo" ? "demo" : "live");

  const pause_trading: ToolDef = {
    name: "pause_trading",
    description: "Pause auto-execution (kill switch ON) for an account. No confirmation phrase needed -- pausing is always the safe direction.",
    parameters: {
      type: "object",
      properties: { account: { type: "string", enum: ["live", "demo"], description: "Defaults to 'live' if omitted." } },
    },
    run: async (input) => {
      const { status, json } = await callOwnApi(ctx.origin, ctx.authHeader, "/api/kill-switch", {
        method: "POST",
        body: { action: "pause", account: accountParam(input) },
      });
      return JSON.stringify({ status, result: json });
    },
  };

  const resume_trading: ToolDef = {
    name: "resume_trading",
    description:
      "Resume auto-execution (kill switch OFF) for an account. This re-arms auto-trading -- only call this when the user has clearly asked to resume, not as a side effect of another request.",
    parameters: {
      type: "object",
      properties: { account: { type: "string", enum: ["live", "demo"], description: "Defaults to 'live' if omitted." } },
    },
    run: async (input) => {
      const { status, json } = await callOwnApi(ctx.origin, ctx.authHeader, "/api/kill-switch", {
        method: "POST",
        body: { action: "resume", account: accountParam(input) },
      });
      return JSON.stringify({ status, result: json });
    },
  };

  const set_engine_mode: ToolDef = {
    name: "set_engine_mode",
    description:
      "Switch the Autopilot engine mode. 'analysis' and 'demo' apply immediately, no confirmation needed. 'live' enables real-money auto-execution and REQUIRES the user to have typed or said the exact phrase 'ENABLE LIVE TRADING' as their own message -- if they have not, this tool refuses and tells you the exact phrase to relay back to them. Never claim live mode is enabled unless this tool's result says ok:true.",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["analysis", "demo", "live"] } },
      required: ["mode"],
    },
    run: async (input) => {
      const mode = input.mode;
      if (mode !== "analysis" && mode !== "demo" && mode !== "live") {
        return JSON.stringify({ ok: false, error: "invalid_mode", message: "mode must be one of analysis, demo, live." });
      }
      if (mode === "live") {
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
        body: { mode, confirmationPhrase: ctx.rawUserMessage },
      });
      return JSON.stringify({ status, result: json });
    },
  };

  const execute_trade: ToolDef = {
    name: "execute_trade",
    description:
      "Execute a specific trade signal by id. REQUIRES the user to have typed or said the exact confirmation phrase for that signal (from get_signals' confirmPhraseRequiredToExecute, e.g. 'CONFIRM BUY EURUSD') as their own message -- if they have not, this tool refuses and tells you the exact phrase to relay back to them. Never claim a trade was placed unless this tool's result says status:'filled'.",
    parameters: {
      type: "object",
      properties: { signalId: { type: "string" } },
      required: ["signalId"],
    },
    run: async (input) => {
      const signalId = input.signalId;
      if (typeof signalId !== "string" || !signalId) {
        return JSON.stringify({ ok: false, error: "invalid_input", message: "signalId (string) is required." });
      }
      const signal = signalStore.get(signalId);
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

      const { json } = await callOwnApi(ctx.origin, ctx.authHeader, `/api/signals/${signalId}/execute`, {
        method: "POST",
        // The execute route now requires this itself (confirmationMode.ts's gate) --
        // already computed and verified above against the user's own raw message, so
        // this just forwards the exact same phrase, not a second independent check.
        body: { confirmationPhrase: requiredPhrase },
      });
      const result = json as ExecuteResponse;
      return JSON.stringify({ ok: true, result, spoken: buildResultAnnouncement(signal, result) });
    },
  };

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
