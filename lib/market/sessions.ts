import type { Session } from "./types";

// UTC hour windows (GMT === UTC, no daylight-saving offset to apply). London/NY
// killzones are the high-liquidity opening windows ICT-style strategies key off; Asia is
// included for the off-hours accumulation range.
const LONDON = { startHour: 8, endHour: 11 };
const NEW_YORK = { startHour: 13, endHour: 17 };
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
