import type { ExecuteResponse } from "../market/executionClient";
import { formatPrice } from "../market/format";
import { describeNoTradeReason } from "../market/noTradeReason";
import { predictionHeadline } from "../market/predictionLabel";
import type { Pair, PredictionUpdate, Signal, Timeframe } from "../market/types";

// Friendlier spoken names for the current PAIRS list (lib/market/types.ts) -- spells out
// ticker-style pairs letter by letter so TTS engines don't mangle "EURUSD" as a word.
const PAIR_SPOKEN_NAMES: Record<Pair, string> = {
  "EUR/USD": "Euro against the US Dollar, E U R U S D",
  "GBP/USD": "British Pound against the US Dollar, G B P U S D",
  "USD/JPY": "US Dollar against the Japanese Yen, U S D J P Y",
  "AUD/USD": "Australian Dollar against the US Dollar, A U D U S D",
  "USD/CAD": "US Dollar against the Canadian Dollar, U S D C A D",
  "XAU/USD": "Gold against the US Dollar",
  "XAG/USD": "Silver against the US Dollar",
  USOIL: "US Crude Oil",
  UKOIL: "UK Brent Oil",
  "BTC/USD": "Bitcoin against the US Dollar, B T C U S D",
};

// Three independent signal engines (15m/30m/1h, see SIGNAL_TIMEFRAMES in
// metaApiConnection.ts) can now announce for the same pair moments apart -- spoken so a
// listener can tell them apart rather than hearing two unqualified "BUY EURUSD"s in a row.
const TIMEFRAME_SPOKEN: Record<Timeframe, string> = {
  "5m": "5 minute",
  "15m": "15 minute",
  "30m": "30 minute",
  "1h": "1 hour",
  "4h": "4 hour",
  "1d": "daily",
};

/** Ticker form used in the spoken confirmation phrase, e.g. "BTC/USD" -> "BTCUSD". */
function tickerWord(pair: Pair): string {
  return pair.replace("/", "");
}

/** The exact phrase the user must say to hard-confirm a trade -- deliberately requires an
 * exact match (see parseVoiceCommand) so background noise or a vague "yes" can never fire
 * a live order by itself. */
export function buildConfirmPhrase(signal: Signal): string {
  const directionWord = signal.direction === "long" ? "BUY" : "SELL";
  return `CONFIRM ${directionWord} ${tickerWord(signal.pair)}`;
}

/** Short spoken summary of which Signer B (independent confirmation) factors actively
 * support this signal's direction -- e.g. "the EMA trend and Supertrend are confirming
 * the move." Omits factors that are unavailable, neutral, or conflicting rather than
 * mentioning them negatively here -- Signer B's own direction must already agree with
 * SMC's for a signal to have been produced at all (a real conflict holds the trade,
 * see decisionMatrix.ts), so nothing here is ever a disagreement, just factors that
 * weren't decisive. */
function confirmationSummary(signal: Signal): string {
  const supporting: string[] = [];
  if (signal.signerBEmaTrend !== "unavailable" && signal.signerBEmaTrend === (signal.direction === "long" ? "bullish" : "bearish")) {
    supporting.push("the EMA trend");
  }
  if (signal.supertrendTrend !== "unavailable" && signal.supertrendTrend === (signal.direction === "long" ? "up" : "down")) {
    supporting.push("Supertrend");
  }
  if (signal.usdStrengthStatus === "supports") supporting.push("currency strength");
  if (
    signal.rsiDivergence !== "unavailable" &&
    signal.rsiDivergence !== "none" &&
    signal.rsiDivergence === (signal.direction === "long" ? "bullish" : "bearish")
  ) {
    supporting.push("RSI divergence");
  }

  if (supporting.length === 0) return "";
  const list = supporting.length === 1 ? supporting[0] : `${supporting.slice(0, -1).join(", ")} and ${supporting[supporting.length - 1]}`;
  return `${list} ${supporting.length === 1 ? "is" : "are"} confirming the move.`;
}

export function buildSignalAnnouncement(signal: Signal, riskPerTradePct: number): string {
  const directionWord = signal.direction === "long" ? "buy" : "sell";
  return [
    `Hello Jude. I have a potential ${directionWord} opportunity.`,
    `The market is ${PAIR_SPOKEN_NAMES[signal.pair]}, on the ${TIMEFRAME_SPOKEN[signal.timeframe]} timeframe.`,
    `The proposed entry is ${formatPrice(signal.pair, signal.entry)}.`,
    `The stop loss is ${formatPrice(signal.pair, signal.stopLoss)}.`,
    `The take profit is ${formatPrice(signal.pair, signal.takeProfit)}.`,
    `The risk is ${riskPerTradePct} percent.`,
    `The risk to reward ratio is ${signal.riskReward.toFixed(1)}.`,
    confirmationSummary(signal),
    `The AI confidence is ${Math.round(signal.confidence)} percent.`,
    "Would you like me to place this trade?",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * A short status readout for a prediction-headline change on the currently selected
 * pair -- distinct from buildSignalAnnouncement's full trade pitch, since this fires on
 * *any* headline change (including into NEUTRAL/NO TRADE), not just a new executable
 * signal. Never fabricates a reason -- the no_trade/watch detail comes straight from
 * describeNoTradeReason / the real Signal fields.
 */
export function buildPredictionAnnouncement(update: PredictionUpdate): string {
  const pairName = PAIR_SPOKEN_NAMES[update.pair];
  const timeframeWord = TIMEFRAME_SPOKEN[update.timeframe];

  if (update.evaluation.status === "no_trade") {
    return `Jude, ${pairName} is now no trade on the ${timeframeWord} timeframe. ${describeNoTradeReason(update.evaluation.reason, update.regime)}`;
  }

  const { signal } = update.evaluation;
  if (signal.tier === "watch") {
    const lean = signal.direction === "long" ? "buy" : "sell";
    return `Jude, ${pairName} has moved to neutral on the ${timeframeWord} timeframe -- leaning ${lean} at ${signal.confidence.toFixed(0)} percent, below the execution threshold.`;
  }

  const headline = predictionHeadline(update.evaluation).toLowerCase();
  return `Jude, ${pairName} is now a ${headline} at ${signal.confidence.toFixed(0)} percent confidence on the ${timeframeWord} timeframe.`;
}

function blockedReasonSpeech(code: string, reason: string): string {
  switch (code) {
    case "stale_price":
      return "The market has moved since I gave you the recommendation. I have cancelled the original order. Would you like me to review the updated setup?";
    case "cooldown":
      return "Your trading activity has exceeded your configured risk limit, so I'm not able to place this. " + reason;
    case "daily_loss":
    case "halted":
      return "Autopilot is locked for today -- the daily loss limit has already been reached.";
    default:
      return reason;
  }
}

/** Never says "trade placed" unless `result.status === "filled"` -- MetaApi's own
 * confirmation, relayed through the backend, is what triggers that line. */
export function buildResultAnnouncement(signal: Signal, result: ExecuteResponse): string {
  const pairWord = tickerWord(signal.pair);
  const directionWord = signal.direction === "long" ? "buy" : "sell";

  switch (result.status) {
    case "filled": {
      const { trade } = result;
      return [
        "Jude, the trade has been placed successfully.",
        `${pairWord} ${directionWord}.`,
        `Entry price ${formatPrice(signal.pair, trade.filledEntry ?? trade.requestedEntry)}.`,
        `Stop loss ${formatPrice(signal.pair, trade.stopLoss)}.`,
        `Take profit ${formatPrice(signal.pair, trade.takeProfit)}.`,
        `Position size ${trade.requestedLots}.`,
        "I'll monitor the position.",
      ].join(" ");
    }
    case "rejected":
      return `Jude, I could not place the trade. ${result.trade.rejectReason ?? "The broker rejected the order."}`;
    case "blocked":
      return `Jude, I could not place the trade. ${blockedReasonSpeech(result.code, result.reason)}`;
    case "skipped_sizing":
      return `Jude, I could not place the trade. ${result.reason}`;
    case "duplicate":
      return "That trade has already been submitted -- no second order was placed.";
    case "not_found":
      return "That signal has expired. No trade has been placed.";
    case "network_error":
      return "I couldn't reach the server to place that trade. No trade has been placed.";
  }
}

/** Proactive JUDE AI Trade Guardian announcements -- spoken the moment a cooldown/halt
 * trips (see useVoiceAssistant's risk-status poll), not just reactively when a blocked
 * execution attempt happens to surface the same code (see blockedReasonSpeech above). */
export function buildCooldownAnnouncement(maxConsecutiveLosses: number, cooldownMinutes: number): string {
  return `Jude, pause. Your trading activity has exceeded your configured risk limit -- ${maxConsecutiveLosses} losses in a row. No new trade will be allowed for ${cooldownMinutes} minutes.`;
}

export function buildDailyLossAnnouncement(maxDailyLossPct: number): string {
  return `Jude, the daily loss limit of ${maxDailyLossPct} percent has been reached. Autopilot is now locked until the next trading day.`;
}

export type VoiceCommand =
  | { kind: "hard_confirm" }
  | { kind: "soft_confirm" }
  | { kind: "decline" }
  | { kind: "emergency_stop" }
  | { kind: "query_profit" }
  | { kind: "query_positions" }
  | { kind: "query_autopilot_status" }
  | { kind: "unrecognized" };

/** Exported so other exact-phrase safety gates (e.g. the chat tool layer's confirm-phrase
 * check) normalize identically to the voice grammar's own hard_confirm match -- one
 * normalization rule, not two that could quietly drift apart. */
export function normalize(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

// Soft phrases alone are deliberately NOT enough to execute -- they only arm a re-prompt
// for the exact hard-confirm phrase (see useVoiceAssistant's "soft_confirm" handling).
const SOFT_CONFIRM_PHRASES = ["approve", "place the trade", "yes place it", "confirm", "yes", "go ahead", "do it"];
const DECLINE_PHRASES = ["reject", "cancel", "dont place it", "wait", "no"];
const EMERGENCY_PHRASES = ["emergency stop", "stop trading", "disable autopilot", "halt trading"];
const PROFIT_PHRASES = ["whats my current profit", "what is my profit", "show my profit", "current profit", "my profit"];
const POSITIONS_PHRASES = ["show my open trades", "what trades are open", "show open trades", "open positions", "open trades"];
const AUTOPILOT_PHRASES = ["is autopilot active", "is auto pilot active", "autopilot status"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match, not raw substring -- a bare `.includes()` here would classify
 * "I know the risk, go ahead" as a decline (because "KNOW" contains "NO") or "eyeshadow
 * looks nice" as a soft-confirm (because "EYESHADOW" contains "YES"). This drives real
 * trade confirm/decline classification, so a false match isn't just a UX annoyance. */
function matchesAny(normalized: string, phrases: string[]): boolean {
  return phrases.some((phrase) => {
    const normalizedPhrase = normalize(phrase);
    if (normalized === normalizedPhrase) return true;
    return new RegExp(`\\b${escapeRegExp(normalizedPhrase)}\\b`).test(normalized);
  });
}

/**
 * Classifies a recognized transcript. `expectedConfirmPhrase` should be the exact phrase
 * from `buildConfirmPhrase` for whichever signal is currently awaiting confirmation (or
 * null if none is pending) -- only an exact match against it ever counts as "hard_confirm".
 * Checked before every other bucket so "CONFIRM BUY BTCUSD" can't be misread as a bare
 * "confirm" soft-trigger.
 */
export function parseVoiceCommand(transcript: string, expectedConfirmPhrase: string | null): VoiceCommand {
  const normalized = normalize(transcript);
  if (!normalized) return { kind: "unrecognized" };

  if (expectedConfirmPhrase && normalized === normalize(expectedConfirmPhrase)) {
    return { kind: "hard_confirm" };
  }
  if (matchesAny(normalized, EMERGENCY_PHRASES)) return { kind: "emergency_stop" };
  if (matchesAny(normalized, DECLINE_PHRASES)) return { kind: "decline" };
  if (matchesAny(normalized, PROFIT_PHRASES)) return { kind: "query_profit" };
  if (matchesAny(normalized, POSITIONS_PHRASES)) return { kind: "query_positions" };
  if (matchesAny(normalized, AUTOPILOT_PHRASES)) return { kind: "query_autopilot_status" };
  if (matchesAny(normalized, SOFT_CONFIRM_PHRASES)) return { kind: "soft_confirm" };
  return { kind: "unrecognized" };
}
