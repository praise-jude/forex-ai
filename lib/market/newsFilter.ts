import type { Pair } from "./types";

const TICKATLAS_URL = "https://tickatlas.com/v1/calendar";
const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 min -- calendar entries don't need second-by-second freshness
const LOOKAHEAD_HOURS = 168; // 7 days -- TickAtlas's documented max for next_hours
// A high-impact release inside this window before/around the signal's own candle time
// is enough to hold off -- not a hard science, a conservative default matching the
// "if in doubt, don't trade into a headline" spirit of the user's original request.
const NEWS_WINDOW_MINUTES = 30;

// The currencies this app actually trades (see PAIRS in ./types.ts -- this app doesn't
// track any CHF/NZD pairs, see currencyStrength.ts's own comment on the same limit).
// checkNews()'s pair-leg matching (KNOWN_CURRENCIES, below) is derived from this same
// list rather than hand-duplicated, so the two can never silently drift apart again --
// a currency requested from TickAtlas but not recognized as a pair leg (or vice versa)
// would otherwise be a quiet "always reports clear" gap for that currency.
const TRACKED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD"] as const;
const KNOWN_CURRENCIES = new Set<string>(TRACKED_CURRENCIES);

export interface EconomicEvent {
  currency: string;
  event: string;
  impact: "high" | "medium" | "low";
  timeMs: number;
}

export type NewsStatus =
  | { status: "clear" }
  | { status: "high_impact_soon"; event: string; currency: string; minutesUntil: number }
  | { status: "unavailable" };

interface CacheState {
  events: EconomicEvent[];
  /** null until the first fetch attempt resolves (success or failure) -- distinguishes
   * "haven't tried yet" from "tried and it's genuinely empty/unreachable". */
  lastFetchOk: boolean | null;
  started: boolean;
}

const globalKey = Symbol.for("forex-ai.newsFilterCache");
type GlobalWithCache = typeof globalThis & { [globalKey]?: CacheState };
const g = globalThis as GlobalWithCache;
const state: CacheState = g[globalKey] ?? (g[globalKey] = { events: [], lastFetchOk: null, started: false });

function currenciesForPair(pair: Pair): string[] {
  return pair.split("/").filter((leg) => KNOWN_CURRENCIES.has(leg));
}

/**
 * Parses TickAtlas's documented GET /v1/calendar response shape
 * (`{ success: true, data: { events: [{ id, datetime, currency, event, impact,
 * forecast, previous, actual }] } }`, confirmed via a live call before building this)
 * defensively -- any entry that doesn't match the expected fields is skipped rather
 * than guessed at, and events are re-filtered for impact === "high" here even though
 * the request already asks for impact=high server-side (never trust a query param
 * alone). A completely unexpected top-level shape returns an empty array rather than
 * throwing.
 */
export function parseTickAtlasCalendar(json: unknown): EconomicEvent[] {
  if (typeof json !== "object" || json === null || !("data" in json)) return [];
  const data = (json as { data: unknown }).data;
  if (typeof data !== "object" || data === null || !("events" in data)) return [];
  const raw = (data as { events: unknown }).events;
  if (!Array.isArray(raw)) return [];

  const events: EconomicEvent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.impact !== "high") continue;
    const currency = typeof entry.currency === "string" ? entry.currency : null;
    const eventName = typeof entry.event === "string" ? entry.event : null;
    const timeMs = typeof entry.datetime === "string" ? Date.parse(entry.datetime) : NaN;
    if (!currency || !eventName || Number.isNaN(timeMs)) continue;

    events.push({ currency, event: eventName, impact: "high", timeMs });
  }
  return events;
}

async function refreshOnce(): Promise<void> {
  const apiKey = process.env.TICKATLAS_API_KEY;
  if (!apiKey) {
    state.lastFetchOk = false;
    return;
  }

  try {
    const url = `${TICKATLAS_URL}?next_hours=${LOOKAHEAD_HOURS}&impact=high&currencies=${TRACKED_CURRENCIES.join(",")}&limit=500`;
    const response = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!response.ok) {
      console.error(`[newsFilter] TickAtlas request failed (${response.status}): ${await response.text().catch(() => "")}`);
      state.lastFetchOk = false;
      return;
    }
    const json = await response.json();
    state.events = parseTickAtlasCalendar(json);
    state.lastFetchOk = true;
  } catch (error) {
    console.error("[newsFilter] TickAtlas request failed:", error);
    state.lastFetchOk = false;
  }
}

/** Called once from bootstrap.ts, mirroring connectionWatcher.ts's own
 * fetch-then-interval pattern. Never awaited by evaluateSignal -- checkNews() below
 * always reads the already-populated cache synchronously. */
export function startNewsFilter(): void {
  if (state.started) return;
  state.started = true;
  void refreshOnce();
  setInterval(() => void refreshOnce(), REFRESH_INTERVAL_MS);
}

/**
 * Synchronous read of the cache -- never makes a network call itself. "unavailable"
 * whenever the cache hasn't been successfully populated yet (missing/invalid API key,
 * network failure, or simply not started) -- never reports "clear" as a guess.
 */
export function checkNews(pair: Pair, atTimeMs: number): NewsStatus {
  if (state.lastFetchOk !== true) return { status: "unavailable" };

  const currencies = currenciesForPair(pair);
  const windowMs = NEWS_WINDOW_MINUTES * 60_000;

  for (const event of state.events) {
    if (!currencies.includes(event.currency)) continue;
    const diff = event.timeMs - atTimeMs;
    if (diff >= -windowMs && diff <= windowMs) {
      return { status: "high_impact_soon", event: event.event, currency: event.currency, minutesUntil: Math.round(diff / 60_000) };
    }
  }
  return { status: "clear" };
}

/** Used by tests to reset cache state between cases. */
export function resetNewsFilterForTests(): void {
  state.events = [];
  state.lastFetchOk = null;
  state.started = false;
}

/** Used by tests to seed the cache directly, bypassing the network fetch --
 * checkNews()'s window/currency-matching logic is what's under test, not TickAtlas
 * connectivity itself. */
export function setNewsFilterStateForTests(events: EconomicEvent[], lastFetchOk: boolean): void {
  state.events = events;
  state.lastFetchOk = lastFetchOk;
}

/** Debug snapshot for /api/health -- reports presence/health, never a secret value
 * itself (same convention as getConnectionStatus in metaApiConnection.ts). */
export function newsFilterStatus(): { configured: boolean; lastFetchOk: boolean | null; eventCount: number } {
  return {
    configured: Boolean(process.env.TICKATLAS_API_KEY),
    lastFetchOk: state.lastFetchOk,
    eventCount: state.events.length,
  };
}
