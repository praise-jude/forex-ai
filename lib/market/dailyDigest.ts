import fs from "node:fs";
import { getPerformanceStats, tradeJournal } from "./tradeJournal";
import { sendNotification } from "./pushNotifier";

// Runtime state, not source -- survives a restart so a redeploy right at the daily
// boundary can't cause a duplicate (or missed) digest. Same on-disk-JSON-file
// convention as weeklyDigest.ts's own state file.
const STORE_FILE = process.env.DAILY_DIGEST_STORE_FILE ?? ".daily-digest-state.json";

interface DigestState {
  lastSentDayKey: string | null;
}

function readState(): DigestState {
  try {
    // turbopackIgnore: STORE_FILE is an operator-configured path (often outside the
    // project directory, e.g. a Railway persistent volume) -- not something to trace
    // and bundle the whole project around.
    const raw = fs.readFileSync(/* turbopackIgnore: true */ STORE_FILE, "utf-8");
    return JSON.parse(raw) as DigestState;
  } catch {
    // Missing file (first boot) or corrupt content -- start fresh rather than crash
    // the whole server over a runtime-state file, same philosophy as weeklyDigest.ts.
    return { lastSentDayKey: null };
  }
}

function writeState(state: DigestState): void {
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

/** Calendar day key in UTC (e.g. "2026-08-16") -- used purely as a "have we already
 * sent today's digest" comparison key, not for display. */
export function isoDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// A fixed UTC anchor, not localized to the operator's own timezone -- same honest-
// simplification posture as weeklyDigest.ts's own WEEKLY_ANCHOR_HOUR_UTC. 20:00 UTC is
// a reasonable "trading day is winding down" moment across a wide span of timezones,
// not a claim that it's actually evening wherever the operator happens to be.
const DAILY_ANCHOR_HOUR_UTC = 20;

/** True from the anchor hour through the rest of that UTC day -- checked against an
 * hourly poll rather than trying to fire a `setInterval` timed to exactly 24 hours
 * (which wouldn't survive a redeploy cleanly), same reasoning as
 * weeklyDigest.ts's own isPastWeeklyAnchor. */
export function isPastDailyAnchor(date: Date): boolean {
  return date.getUTCHours() >= DAILY_ANCHOR_HOUR_UTC;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function buildDigestMessage(now: Date): { title: string; body: string } {
  const cutoff = startOfUtcDay(now);
  const todaysEntries = tradeJournal.all().filter((e) => e.closedAt >= cutoff);
  const stats = getPerformanceStats(todaysEntries);

  if (stats.count === 0) {
    return { title: "Daily Auto Pilot digest", body: "No closed trades today." };
  }

  const rPart = stats.averageR === null ? "" : ` ${stats.averageR >= 0 ? "+" : ""}${stats.averageR.toFixed(1)}R avg`;
  return {
    title: "Daily Auto Pilot digest",
    body: `${stats.count} trade${stats.count === 1 ? "" : "s"} today: ${stats.winRate.toFixed(0)}% win rate.${rPart}`,
  };
}

async function tick(): Promise<void> {
  const now = new Date();
  const dayKey = isoDayKey(now);
  const state = readState();
  if (state.lastSentDayKey === dayKey) return;
  if (!isPastDailyAnchor(now)) return;

  const { title, body } = buildDigestMessage(now);
  await sendNotification({ category: "daily_digest", title, body });
  writeState({ lastSentDayKey: dayKey });
}

// Checked hourly, not daily -- same "coarse timer compared against a persisted day key
// is far more restart/redeploy-safe than timing a literal 24h setInterval" reasoning as
// weeklyDigest.ts.
const POLL_INTERVAL_MS = 60 * 60 * 1000;

const globalKey = Symbol.for("forex-ai.dailyDigest");
type GlobalWithState = typeof globalThis & { [globalKey]?: { started: boolean } };
const g = globalThis as GlobalWithState;
const globalState = g[globalKey] ?? (g[globalKey] = { started: false });

export function startDailyDigest(): void {
  if (globalState.started) return;
  globalState.started = true;

  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
