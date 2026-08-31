import type { Pair } from "./types";
import { isCrypto, isStock } from "./symbols";
import { isTickStale } from "./marketHealth";

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

// Exported for signalEngine.ts's own weekend-close-blackout hoursUntilClose computation
// -- avoids a second, independently-maintained copy of this DST-safe NY-local-time
// conversion (including the ICU midnight-as-"24" normalization below).
export function nyWeekdayAndHour(utcMs: number): { weekday: number; hour: number } {
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

/**
 * Whether `pair` should be treated as closed right now. Crypto is exempt (trades 24/7,
 * see isCrypto) -- forex/metals/oil follow the standard weekly session above. Stocks
 * (NFLX/MSFT/SPCX) get neither rule -- their own daily window has no relationship to
 * the forex week, and hardcoding a broker-server-time conversion here isn't reliable
 * (see symbols.ts's isStock() doc comment) -- so this falls back to the same honest
 * "hasn't ticked in a while" inference isPriceStale already uses elsewhere, driven by
 * the caller's own last-seen tick time for that pair since this function has no direct
 * price-store access itself. `lastTickMs` is ignored for every other pair.
 */
export function isMarketClosed(pair: Pair, utcMs: number, lastTickMs?: number | null): boolean {
  if (isCrypto(pair)) return false;
  if (isStock(pair)) return isTickStale(lastTickMs, utcMs);
  return isForexWeeklyClose(utcMs);
}

/**
 * Whether `pair` is within `hoursBefore` hours of the Friday 5pm New York weekly close --
 * used to gate NEW auto-execution from opening a position that would otherwise sit
 * through the weekend gap (see signalEngine.ts's own "weekend_close_blackout" no-trade
 * code). Crypto is exempt (trades straight through the weekend, no gap -- see isCrypto).
 * Deliberately one-sided: only checks the Friday-approaching-close side, never the
 * Sunday-just-reopened side -- a position opened moments after Sunday's reopen carries
 * no more gap risk than any other open position, there's no equivalent "just opened"
 * danger window the way there is heading into a close. Callers should pass a small
 * `hoursBefore` (a handful of hours, not a full day) -- this only checks Friday itself,
 * so a `hoursBefore` large enough to reach back into Thursday would silently stop
 * working rather than roll over correctly.
 */
export function isWithinWeekendCloseWindow(pair: Pair, utcMs: number, hoursBefore: number): boolean {
  if (isCrypto(pair)) return false;
  const { weekday, hour } = nyWeekdayAndHour(utcMs);
  if (weekday !== 5) return false;
  return hour >= 17 - hoursBefore && hour < 17;
}
