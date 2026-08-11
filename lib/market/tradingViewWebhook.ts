import type { Signal, Timeframe } from "./types";
import { pairForPlainSymbol } from "./symbols";
import { getActiveSession } from "./sessions";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];
const DEFAULT_TIMEFRAME: Timeframe = "15m";
export const DEFAULT_MAX_ALERT_AGE_MS = 60_000;

// A timestamp this large can only be milliseconds already (a seconds-based Unix time
// won't reach 10^12 until the year 33658) -- TradingView's {{timenow}} is documented as
// UNIX seconds, so this auto-detects and normalizes rather than requiring the user to
// do unit conversion inside Pine Script, which isn't a natural place for it.
const MS_THRESHOLD = 10 ** 12;

export interface ParseOptions {
  maxAgeMs?: number;
  now?: number;
}

export type ParseResult = { signal: Signal } | { error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDirection(value: unknown): "long" | "short" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "buy" || normalized === "long") return "long";
  if (normalized === "sell" || normalized === "short") return "short";
  return undefined;
}

/**
 * Validates a TradingView alert payload and builds a Signal from it. Every failure
 * returns a clear error rather than defaulting or partially constructing a signal --
 * this feeds directly into live order placement, so bad input must be rejected, not
 * guessed at.
 */
export function parseTradingViewAlert(body: unknown, options: ParseOptions = {}): ParseResult {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_ALERT_AGE_MS;
  const nowMs = options.now ?? Date.now();
  if (!body || typeof body !== "object") return { error: "payload must be a JSON object" };
  const b = body as Record<string, unknown>;

  // Mandatory, not server-generated: a redelivered/retried alert must map to the same
  // id so positionStore.hasExecuted() catches it, instead of executing twice.
  const id = b.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return { error: "id is required (use a value stable per alert, e.g. TradingView's {{timenow}})" };
  }

  if (typeof b.pair !== "string") return { error: "pair is required" };
  const pair = pairForPlainSymbol(b.pair);
  if (!pair) return { error: `unrecognized pair: ${b.pair}` };

  const direction = parseDirection(b.direction);
  if (!direction) return { error: 'direction must be "buy"/"long" or "sell"/"short"' };

  if (!isFiniteNumber(b.entry)) return { error: "entry must be a number" };
  if (!isFiniteNumber(b.stopLoss)) return { error: "stopLoss must be a number" };
  if (!isFiniteNumber(b.takeProfit)) return { error: "takeProfit must be a number" };
  const entry = b.entry;
  const stopLoss = b.stopLoss;
  const takeProfit = b.takeProfit;

  const takeProfit2 = b.takeProfit2 === undefined ? takeProfit : b.takeProfit2;
  if (!isFiniteNumber(takeProfit2)) return { error: "takeProfit2 must be a number if provided" };

  // A misconfigured alert must never place a geometrically broken order -- the SMC
  // engine always computes these itself; here they're user-supplied, so they're
  // validated instead.
  const structurallySound =
    direction === "long" ? stopLoss < entry && entry < takeProfit : stopLoss > entry && entry > takeProfit;
  if (!structurallySound) {
    return { error: `stopLoss/takeProfit are on the wrong side of entry for a ${direction} trade` };
  }

  const timeframe =
    typeof b.timeframe === "string" && TIMEFRAMES.includes(b.timeframe as Timeframe)
      ? (b.timeframe as Timeframe)
      : DEFAULT_TIMEFRAME;

  // Required, separate from `id` (which only needs to be stable, not a real clock
  // reading) -- a delayed or queued alert must not fire on market conditions that no
  // longer hold. Accepts TradingView's {{timenow}} (UNIX seconds) directly.
  if (!isFiniteNumber(b.timestamp)) {
    return { error: "timestamp is required (use TradingView's {{timenow}})" };
  }
  const timestampMs = b.timestamp < MS_THRESHOLD ? b.timestamp * 1000 : b.timestamp;
  const ageMs = nowMs - timestampMs;
  if (Math.abs(ageMs) > maxAgeMs) {
    const ageSeconds = (ageMs / 1000).toFixed(1);
    return { error: `alert is stale or clock-skewed (${ageSeconds}s from now, max allowed ${maxAgeMs / 1000}s)` };
  }

  const now = nowMs;
  const signal: Signal = {
    id: `tv-${id}`,
    source: "tradingview",
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss),
    // Placeholder values -- the SMC confidence/direction/entry scoring doesn't apply to
    // an externally-sourced signal. Fixed at "buy" (never "watch") so this doesn't trip
    // executionEngine.ts's watch-tier guard; confluences stays empty since none of the
    // SMC confluence types describe what actually triggered this signal.
    confidence: 100,
    directionScore: 100,
    entryScore: 100,
    confirmationScore: 100,
    tier: "buy",
    confluences: [],
    session: getActiveSession(now),
    timeframe,
    createdAt: now,
    // The confirmation layer (Supertrend/currency strength/news) is derived from this
    // app's own candle history and calendar cache -- neither applies to an externally
    // sourced webhook signal, so these are honestly "unavailable", not fabricated.
    supertrendTrend: "unavailable",
    usdStrengthStatus: "unavailable",
    newsStatus: "unavailable",
  };

  return { signal };
}

