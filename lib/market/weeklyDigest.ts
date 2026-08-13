import fs from "node:fs";
import { getPerformanceStats, tradeJournal } from "./tradeJournal";
import { sendNotification } from "./pushNotifier";

// Runtime state, not source -- survives a restart so a redeploy right at the weekly
// boundary can't cause a duplicate (or missed) digest. Same on-disk-JSON-file
// convention as deviceStore.ts/.device-tokens.json.
const STORE_FILE = process.env.WEEKLY_DIGEST_STORE_FILE ?? ".weekly-digest-state.json";

interface DigestState {
  lastSentWeekKey: string | null;
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
    // the whole server over a runtime-state file, same philosophy as deviceStore.ts.
    return { lastSentWeekKey: null };
  }
}

function writeState(state: DigestState): void {
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

/** Standard ISO 8601 week key (e.g. "2026-W33") -- weeks run Monday-Sunday. Used purely
 * as a "have we already sent this week's digest" comparison key, not for display. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7 (getUTCDay's Sun=0 remapped to 7)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this ISO week -- determines the ISO year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

const WEEKLY_ANCHOR_HOUR_UTC = 8;

/** True any time from Monday 08:00 UTC through the end of Sunday -- i.e. "this ISO
 * week's anchor has passed", checked against an hourly poll rather than trying to fire
 * a `setInterval` timed to exactly 7 days (which wouldn't survive a redeploy cleanly). */
export function isPastWeeklyAnchor(date: Date): boolean {
  const day = date.getUTCDay(); // Sun=0, Mon=1, ... Sat=6
  if (day !== 1) return true; // any day other than Monday is necessarily past that week's Monday anchor
  return date.getUTCHours() >= WEEKLY_ANCHOR_HOUR_UTC;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function buildDigestMessage(now: number): { title: string; body: string } {
  const cutoff = now - SEVEN_DAYS_MS;
  const recentEntries = tradeJournal.all().filter((e) => e.closedAt >= cutoff);
  const stats = getPerformanceStats(recentEntries);

  if (stats.count === 0) {
    return { title: "Weekly Auto Pilot digest", body: "No closed trades this week." };
  }

  const rPart = stats.averageR === null ? "" : ` ${stats.averageR >= 0 ? "+" : ""}${stats.averageR.toFixed(1)}R avg`;
  return {
    title: "Weekly Auto Pilot digest",
    body: `${stats.count} trade${stats.count === 1 ? "" : "s"} this week: ${stats.winRate.toFixed(0)}% win rate.${rPart}`,
  };
}

async function tick(): Promise<void> {
  const now = new Date();
  const weekKey = isoWeekKey(now);
  const state = readState();
  if (state.lastSentWeekKey === weekKey) return;
  if (!isPastWeeklyAnchor(now)) return;

  const { title, body } = buildDigestMessage(now.getTime());
  await sendNotification({ category: "weekly_digest", title, body });
  writeState({ lastSentWeekKey: weekKey });
}

// Checked hourly, not weekly -- a coarse timer compared against a persisted week key is
// far more restart/redeploy-safe than timing a literal 7-day setInterval, same reasoning
// documented on positionManager.ts's own poll interval.
const POLL_INTERVAL_MS = 60 * 60 * 1000;

const globalKey = Symbol.for("forex-ai.weeklyDigest");
type GlobalWithState = typeof globalThis & { [globalKey]?: { started: boolean } };
const g = globalThis as GlobalWithState;
const globalState = g[globalKey] ?? (g[globalKey] = { started: false });

export function startWeeklyDigest(): void {
  if (globalState.started) return;
  globalState.started = true;

  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
