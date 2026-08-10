import type { Confluence, NoTradeReason } from "./types";

// Only the tags scoreDirection()/scoreEntry() in confidenceScore.ts can ever produce --
// used to describe what's *missing* by set-subtracting from DimensionScore.reasons,
// never to invent a new confluence concept.
const DIRECTION_TAGS: Confluence[] = ["trend_ema_stack", "market_structure", "adx"];
const ENTRY_TAGS: Confluence[] = ["candlestick", "macd_crossover", "rsi_momentum", "volume"];

const TAG_LABEL: Partial<Record<Confluence, string>> = {
  trend_ema_stack: "EMA stack alignment",
  market_structure: "market structure agreement",
  adx: "a strong ADX reading",
  candlestick: "a matching candlestick pattern",
  macd_crossover: "MACD confirmation",
  rsi_momentum: "RSI momentum",
  volume: "above-average volume",
};

function missing(present: Confluence[], all: Confluence[]): string[] {
  const presentSet = new Set(present);
  return all.filter((tag) => !presentSet.has(tag)).map((tag) => TAG_LABEL[tag] ?? tag);
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Turns a NoTradeReason into a plain-language explanation, built entirely from the
 * real gate/score data the engine already computed -- never a canned "conditions
 * unclear" placeholder. Shared by the web/mobile prediction cards and voice, so the
 * wording is identical everywhere a NoTradeReason is shown.
 */
export function describeNoTradeReason(reason: NoTradeReason): string {
  switch (reason.code) {
    case "outside_killzone":
      return "Outside the London/New York killzone -- the SMC engine only evaluates setups during active institutional trading sessions.";
    case "no_setup":
      return "No qualifying setup right now -- no recent liquidity sweep with a confirming structure break and a freshly-tagged order block or fair value gap.";
    case "trend_disagreement": {
      const wanted = reason.impliedDirection === "long" ? "bullish" : "bearish";
      return `A setup formed, but the daily/4-hour/1-hour trend doesn't agree (D1 ${reason.d1}, H4 ${reason.h4}, H1 ${reason.h1}) -- all three must be ${wanted} for a ${reason.impliedDirection === "long" ? "buy" : "sell"}.`;
    }
    case "weak_trend_adx":
      return `Trend strength is too weak (ADX ${reason.adx.toFixed(1)}, needs 20+) -- the market isn't trending enough to trust a directional setup right now.`;
    case "low_volatility":
      return `Volatility is below its recent average (ATR ${reason.atr.toFixed(5)} vs ${reason.atrAverage.toFixed(5)} average) -- conditions are too quiet for a reliable move.`;
    case "below_threshold": {
      const missingDirection = missing(reason.direction.reasons, DIRECTION_TAGS);
      const missingEntry = missing(reason.entry.reasons, ENTRY_TAGS);
      const parts: string[] = [];
      parts.push(`Direction confidence ${reason.direction.total.toFixed(0)}%, entry confidence ${reason.entry.total.toFixed(0)}%`);
      if (missingDirection.length > 0) parts.push(`missing ${joinList(missingDirection)}`);
      if (missingEntry.length > 0) parts.push(`missing ${joinList(missingEntry)}`);
      return `${parts.join(" -- ")}.`;
    }
  }
}
