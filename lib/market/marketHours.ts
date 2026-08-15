import type { Pair } from "./types";
import { isCrypto } from "./symbols";

// Standard forex/metals/oil weekly session: opens Sunday 5pm New York time, closes
// Friday 5pm New York time -- the same convention every major broker uses (tied to
// Sydney picking up as New York's trading day ends). Computed against NY's own local
// time (not a fixed UTC offset), for the same reason sessions.ts's killzones are: EST/EDT
// DST transitions move the UTC-equivalent boundary by an hour, and the US's DST calendar
// doesn't line up with any other region's. This is a fixed weekly rule, not a full
// trading calendar -- it doesn't know about broker-specific holiday closures.
const NY_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  hour12: false,
});

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nyWeekdayAndHour(utcMs: number): { weekday: number; hour: number } {
  const parts = NY_TIME_FORMATTER.formatToParts(new Date(utcMs));
  const weekdayPart = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const hour = Number(hourPart);
  // en-US's 24-hour ("H") pattern reports midnight as "24" in some ICU versions rather
  // than "0" -- normalize so the boundary checks below never silently miss midnight.
  return { weekday: WEEKDAY_INDEX[weekdayPart] ?? 0, hour: hour === 24 ? 0 : hour };
}

function isForexWeeklyClose(utcMs: number): boolean {
  const { weekday, hour } = nyWeekdayAndHour(utcMs);
  if (weekday === 6) return true; // Saturday, all day NY time
  if (weekday === 0) return hour < 17; // Sunday, before 5pm NY reopen
  if (weekday === 5) return hour >= 17; // Friday, from 5pm NY close
  return false;
}

/** Whether `pair` should be treated as closed right now. Crypto is exempt (trades
 * 24/7, see isCrypto) -- every other pair here (forex, metals, oil) follows the same
 * standard weekly session. */
export function isMarketClosed(pair: Pair, utcMs: number): boolean {
  if (isCrypto(pair)) return false;
  return isForexWeeklyClose(utcMs);
}
