import { gte } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { evaluationLog as evaluationLogTable } from "../db/tradingSchema";
import { sendNotification } from "./pushNotifier";

/**
 * A running "what has autopilot been doing" summary, pushed automatically every hour --
 * built from evaluation_log, the same real data the dashboard's diagnostics panel and
 * history already read from. Deliberately NOT a re-run of anything: no backtest, no
 * MetaApi call of any kind, purely a read of rows the live engine already wrote as it
 * evaluated real candle closes. Answers the actual thing repeatedly asked about tonight
 * ("is anything firing, what's blocking it") without the risk a literal automated
 * backtest loop would have carried (see the 2026-09-01 incidents this was proposed as
 * the safe alternative to).
 */

const SUMMARY_INTERVAL_MS = 60 * 60 * 1000;

function reasonLabel(code: string): string {
  const labels: Record<string, string> = {
    outside_killzone: "outside killzone",
    no_setup: "no setup",
    trend_disagreement: "trend disagreement",
    weak_trend_adx: "weak trend",
    low_volatility: "low volatility",
    below_threshold: "below confidence threshold",
    news_blackout: "news blackout",
    weekend_close_blackout: "weekend blackout",
    signer_b_neutral: "signer B neutral",
    signer_conflict: "signer B conflict",
    m5_not_confirmed: "M5 not confirmed",
    not_ranging: "not ranging",
    no_range_detected: "no range detected",
    no_boundary_touch: "no boundary touch",
    range_below_threshold: "range confidence too low",
  };
  return labels[code] ?? code;
}

export interface EvaluationLogRowLike {
  status: string;
  reasonCode: string | null;
  pair: string;
  signalTier: string | null;
}

/** Pure formatting, split out from the DB read below so it's directly testable without
 * mocking drizzle's own query chain. */
export function formatHourlySummary(rows: EvaluationLogRowLike[]): { title: string; body: string } {
  const title = "JUDE AI — Hourly activity";
  if (rows.length === 0) {
    return { title, body: "No evaluations in the last hour -- the engine may be quiet or the market closed." };
  }

  const signals = rows.filter((r) => r.status === "signal");
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== "no_trade" || !row.reasonCode) continue;
    reasonCounts.set(row.reasonCode, (reasonCounts.get(row.reasonCode) ?? 0) + 1);
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => `${reasonLabel(code)} (${count})`);

  const parts: string[] = [`${rows.length} evaluation${rows.length === 1 ? "" : "s"} in the last hour`];
  if (signals.length > 0) {
    const tiers = signals.map((s) => `${s.pair} ${s.signalTier ?? "?"}`).join(", ");
    parts.push(`${signals.length} signal${signals.length === 1 ? "" : "s"}: ${tiers}`);
  } else {
    parts.push("no signals");
  }
  if (topReasons.length > 0) parts.push(`mostly held back by: ${topReasons.join(", ")}`);

  return { title, body: parts.join(". ") + "." };
}

async function buildSummary(): Promise<{ title: string; body: string } | null> {
  const db = getOptionalDb();
  if (!db) return null;

  const since = new Date(Date.now() - SUMMARY_INTERVAL_MS);
  const rows = await db.select().from(evaluationLogTable).where(gte(evaluationLogTable.createdAt, since));
  return formatHourlySummary(rows);
}

async function tick(): Promise<void> {
  const summary = await buildSummary();
  if (!summary) return;
  // Reuses the dailyDigest pref (daily_digest) rather than adding a whole new
  // notification category for a second digest-shaped message -- anyone who wants
  // periodic summaries at all can mute this the same one way, and it defaults OFF
  // (see types.ts's DEFAULT_NOTIFICATION_PREFS), so this is opt-in, not a new noisy
  // default for every existing device.
  await sendNotification({ category: "daily_digest", ...summary });
}

const globalKey = Symbol.for("forex-ai.hourlyActivitySummary");
type GlobalWithState = typeof globalThis & { [globalKey]?: { started: boolean } };
const g = globalThis as GlobalWithState;
const state = g[globalKey] ?? (g[globalKey] = { started: false });

/** Called once from bootstrap.ts. Idempotent, same pattern as every other periodic task
 * in this file. Deliberately does NOT fire immediately at boot (unlike dailyDigest's own
 * tick() there) -- this account has had many redeploys in a single session before, and
 * an immediate summary on every one of those would be spam, not useful. Only fires on
 * the hourly interval itself. */
export function startHourlyActivitySummary(): void {
  if (state.started) return;
  state.started = true;
  setInterval(() => {
    void tick().catch((error: unknown) => console.error("[hourlyActivitySummary] failed:", error));
  }, SUMMARY_INTERVAL_MS);
}
