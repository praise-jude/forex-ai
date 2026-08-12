import type { Session } from "./types";

// London/NY killzones are the high-liquidity LOCAL opening windows ICT-style strategies
// key off (e.g. "8-11am London time"), so they must be computed against each region's
// own real local time -- NOT a fixed UTC offset. The UK (BST/GMT) and US (EDT/EST) each
// observe daylight saving on their own calendar (different transition dates from each
// other, and the UK's own start/end dates move year to year) -- a single hardcoded UTC
// window can only ever be correct for whichever few months it happened to be calibrated
// against, silently drifting an hour off for the other ~7 months. Intl.DateTimeFormat
// with an IANA zone name (Node's built-in ICU) computes the real local hour for any
// instant, correctly handling each region's own DST rules without a manual offset table.
//
// London/New York hours are optionally overridable via env vars (LONDON_START_HOUR,
// LONDON_END_HOUR, NEW_YORK_START_HOUR, NEW_YORK_END_HOUR) -- read once at module load,
// falling back to these defaults, and always interpreted as that region's LOCAL hour. An
// invalid/out-of-range value (not 0-23, or a start >= end) is ignored rather than
// producing a broken killzone window. Asia isn't configurable -- it's not part of the
// killzone gate, only informational session labeling, and wasn't requested; it also
// doesn't need DST-aware handling since Japan (the session's reference market) doesn't
// observe daylight saving, so a fixed UTC window is fine there.
function envHour(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

function envWindow(startVar: string, endVar: string, defaults: { startHour: number; endHour: number }): { startHour: number; endHour: number } {
  const startHour = envHour(startVar, defaults.startHour);
  const endHour = envHour(endVar, defaults.endHour);
  return startHour < endHour ? { startHour, endHour } : defaults;
}

const LONDON = envWindow("LONDON_START_HOUR", "LONDON_END_HOUR", { startHour: 8, endHour: 11 });
// The old code stored these as raw UTC-hour literals (13, 17) that only read correctly
// as "8am-12pm New York local" during EST (UTC-5) winter months -- 13-5=8, 17-5=12.
// Converted to their real local-hour equivalents here so the SAME real-world killzone
// window (8am-noon Eastern, the standard ICT NY killzone) now holds correctly year-round
// instead of only during winter.
const NEW_YORK = envWindow("NEW_YORK_START_HOUR", "NEW_YORK_END_HOUR", { startHour: 8, endHour: 12 });
const ASIA = { startHour: 0, endHour: 3 };

const HOUR_FORMATTERS: Record<"Europe/London" | "America/New_York", Intl.DateTimeFormat> = {
  "Europe/London": new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", hour: "numeric", hour12: false }),
  "America/New_York": new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
};

/** The real local wall-clock hour (0-23) for the given instant in `timeZone`, correctly
 * reflecting that region's own DST rules. Reuses one cached Intl.DateTimeFormat per zone
 * rather than constructing one per call -- this runs on every candle close. */
function localHour(utcMs: number, timeZone: "Europe/London" | "America/New_York"): number {
  const hourPart = HOUR_FORMATTERS[timeZone].formatToParts(new Date(utcMs)).find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);
  // en-US's 24-hour ("H") pattern reports midnight as "24" in some ICU versions rather
  // than "0" -- normalize so the 0-23 comparisons below never silently miss midnight.
  return hour === 24 ? 0 : hour;
}

function utcHour(utcMs: number): number {
  return new Date(utcMs).getUTCHours();
}

export function getActiveSession(utcMs: number): Session {
  const londonHour = localHour(utcMs, "Europe/London");
  if (londonHour >= LONDON.startHour && londonHour < LONDON.endHour) return "london";

  const newYorkHour = localHour(utcMs, "America/New_York");
  if (newYorkHour >= NEW_YORK.startHour && newYorkHour < NEW_YORK.endHour) return "newyork";

  const hour = utcHour(utcMs);
  if (hour >= ASIA.startHour && hour < ASIA.endHour) return "asia";
  return "off-session";
}

export function isKillzone(utcMs: number): boolean {
  const session = getActiveSession(utcMs);
  return session === "london" || session === "newyork";
}
