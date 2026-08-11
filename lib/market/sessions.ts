import type { Session } from "./types";

// UTC hour windows (GMT === UTC, no daylight-saving offset to apply). London/NY
// killzones are the high-liquidity opening windows ICT-style strategies key off; Asia is
// included for the off-hours accumulation range.
//
// London/New York hours are optionally overridable via env vars (LONDON_START_HOUR,
// LONDON_END_HOUR, NEW_YORK_START_HOUR, NEW_YORK_END_HOUR) -- read once at module load,
// falling back to these defaults. An invalid/out-of-range value (not 0-23, or a
// start >= end) is ignored rather than producing a broken killzone window. Asia isn't
// configurable -- it's not part of the killzone gate, only informational session
// labeling, and wasn't requested.
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
const NEW_YORK = envWindow("NEW_YORK_START_HOUR", "NEW_YORK_END_HOUR", { startHour: 13, endHour: 17 });
const ASIA = { startHour: 0, endHour: 3 };

function utcHour(utcMs: number): number {
  return new Date(utcMs).getUTCHours();
}

export function getActiveSession(utcMs: number): Session {
  const hour = utcHour(utcMs);
  if (hour >= LONDON.startHour && hour < LONDON.endHour) return "london";
  if (hour >= NEW_YORK.startHour && hour < NEW_YORK.endHour) return "newyork";
  if (hour >= ASIA.startHour && hour < ASIA.endHour) return "asia";
  return "off-session";
}

export function isKillzone(utcMs: number): boolean {
  const session = getActiveSession(utcMs);
  return session === "london" || session === "newyork";
}
