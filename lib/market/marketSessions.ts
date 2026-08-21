// Purely informational market-hours display for the dashboard's "Market Sessions" panel
// (components/dashboard/MarketSessionsPanel.tsx) -- deliberately independent of
// sessions.ts, which is the live trading engine's own killzone/entry-timing logic (its
// "asia" window is a narrow 0-3 UTC SMC-specific concept, not a real Tokyo market-hours
// window, and it has no "sydney" concept at all). Nothing in this file is imported by,
// or imports from, any trading/execution/risk-state code.

export type MarketSessionId = "sydney" | "tokyo" | "london" | "newyork";

interface SessionConfig {
  id: MarketSessionId;
  label: string;
  /** IANA zone for a DST-aware local-hour window, or null for a fixed UTC window
   * (Tokyo -- Japan doesn't observe daylight saving, so a fixed UTC window is accurate
   * and simpler, same reasoning sessions.ts uses for its own Asia window). */
  timeZone: string | null;
  /** Local (or UTC, if timeZone is null) start/end hour. `endHour < startHour` expresses
   * a window that crosses midnight (Sydney: 22:00 -> 07:00). */
  startHour: number;
  endHour: number;
  currencies: string[];
}

const SESSIONS: SessionConfig[] = [
  { id: "sydney", label: "Sydney", timeZone: "Australia/Sydney", startHour: 22, endHour: 7, currencies: ["AUD", "NZD"] },
  { id: "tokyo", label: "Tokyo", timeZone: null, startHour: 0, endHour: 9, currencies: ["JPY", "AUD", "NZD"] },
  { id: "london", label: "London", timeZone: "Europe/London", startHour: 8, endHour: 17, currencies: ["GBP", "EUR", "CHF"] },
  { id: "newyork", label: "New York", timeZone: "America/New_York", startHour: 8, endHour: 17, currencies: ["USD", "CAD"] },
];

const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The real local wall-clock hour (0-23) for the given instant in `timeZone`, correctly
 * reflecting that region's own DST rules. Reuses one cached Intl.DateTimeFormat per zone. */
function localHour(utcMs: number, timeZone: string): number {
  let formatter = HOUR_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false });
    HOUR_FORMATTERS.set(timeZone, formatter);
  }
  const hourPart = formatter.formatToParts(new Date(utcMs)).find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);
  // en-US's 24-hour ("H") pattern reports midnight as "24" in some ICU versions rather
  // than "0" -- normalize so window-boundary comparisons never silently miss midnight.
  return hour === 24 ? 0 : hour;
}

function hourFor(config: SessionConfig, utcMs: number): number {
  return config.timeZone ? localHour(utcMs, config.timeZone) : new Date(utcMs).getUTCHours();
}

function isOpenAt(config: SessionConfig, utcMs: number): boolean {
  const hour = hourFor(config, utcMs);
  if (config.startHour < config.endHour) return hour >= config.startHour && hour < config.endHour;
  // Midnight-crossing window (e.g. Sydney 22 -> 7): open if at/after the start hour OR
  // still before the end hour on the following calendar day.
  return hour >= config.startHour || hour < config.endHour;
}

// Coarse step for the forward scan, refined by a binary search once a flip is found --
// this avoids any bespoke per-timezone date arithmetic (which is exactly where DST
// spring-forward/fall-back and midnight-crossing bugs tend to hide): it just directly
// evaluates the same isOpenAt() the rest of this module uses, at successive real
// instants, so it's correct by construction for every zone/window shape above.
const SEARCH_STEP_MS = 5 * 60_000;
const MAX_SEARCH_MS = 48 * 60 * 60_000;

function findNextTransition(config: SessionConfig, utcMs: number): { atMs: number; toOpen: boolean } {
  const startState = isOpenAt(config, utcMs);
  let t = utcMs;
  while (t - utcMs < MAX_SEARCH_MS) {
    t += SEARCH_STEP_MS;
    if (isOpenAt(config, t) !== startState) {
      let lo = t - SEARCH_STEP_MS;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2);
        if (isOpenAt(config, mid) === startState) lo = mid;
        else hi = mid;
      }
      return { atMs: hi, toOpen: !startState };
    }
  }
  // Every real config window above flips within 24h, so this is unreachable in
  // practice -- fails loudly rather than silently returning a made-up transition.
  throw new Error(`marketSessions: no transition found for "${config.id}" within ${MAX_SEARCH_MS}ms`);
}

const NIGERIA_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false });

/** "HH:MM WAT" for the given instant, always derived from real timezone data (Nigeria
 * is a fixed UTC+1 with no DST, but this still goes through Intl rather than a
 * hardcoded +1 so it stays correct regardless of which UTC moment is passed in). */
function nigeriaTimeLabel(utcMs: number): string {
  return `${NIGERIA_TIME_FORMATTER.format(new Date(utcMs))} WAT`;
}

function windowLabel(config: SessionConfig): string {
  const pad = (h: number) => h.toString().padStart(2, "0");
  return `${pad(config.startHour)}:00 - ${pad(config.endHour)}:00`;
}

export interface SessionStatus {
  id: MarketSessionId;
  label: string;
  currencies: string[];
  isOpen: boolean;
  /** That session's own fixed local (or UTC, for Tokyo) hours, e.g. "08:00 - 17:00". */
  localWindowLabel: string;
  msUntilTransition: number;
  nextTransition: "open" | "close";
  /** Nigeria-local time of the next transition instant above, e.g. "19:00 WAT". */
  nigeriaTransitionLabel: string;
}

export function getSessionStatus(id: MarketSessionId, utcMs: number): SessionStatus {
  const config = SESSIONS.find((s) => s.id === id);
  if (!config) throw new Error(`marketSessions: unknown session id "${id}"`);

  const isOpen = isOpenAt(config, utcMs);
  const transition = findNextTransition(config, utcMs);

  return {
    id: config.id,
    label: config.label,
    currencies: config.currencies,
    isOpen,
    localWindowLabel: windowLabel(config),
    msUntilTransition: transition.atMs - utcMs,
    nextTransition: transition.toOpen ? "open" : "close",
    nigeriaTransitionLabel: nigeriaTimeLabel(transition.atMs),
  };
}

export function getAllSessionStatuses(utcMs: number): SessionStatus[] {
  return SESSIONS.map((config) => getSessionStatus(config.id, utcMs));
}

/** "London + New York" when 2+ sessions are open right now, else null -- the highest
 * real-world liquidity condition among these four is exactly when multiple overlap. */
export function getOverlapLabel(statuses: SessionStatus[]): string | null {
  const open = statuses.filter((s) => s.isOpen);
  if (open.length < 2) return null;
  return open.map((s) => s.label).join(" + ");
}

/** "2h 41m" / "45m" -- compact, never shows seconds (the panel's own live clock already
 * covers second-level precision; a countdown flickering every second is just noise). */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
