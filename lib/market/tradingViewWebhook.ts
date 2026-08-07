import type { Signal, Timeframe } from "./types";
import { pairForPlainSymbol } from "./symbols";
import { getActiveSession } from "./sessions";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];
const DEFAULT_TIMEFRAME: Timeframe = "15m";

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
export function parseTradingViewAlert(body: unknown): ParseResult {
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

  const now = Date.now();
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
    tier: "buy",
    confluences: [],
    session: getActiveSession(now),
    timeframe,
    createdAt: now,
  };

  return { signal };
}

