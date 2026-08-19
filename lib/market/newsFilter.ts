import type { Pair } from "./types";

const TICKATLAS_URL = "https://tickatlas.com/v1/calendar";
const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 min -- calendar entries don't need second-by-second freshness
const LOOKAHEAD_HOURS = 168; // 7 days -- TickAtlas's documented max for next_hours
// FMP's economic calendar (financialmodelingprep.com) -- unlike TickAtlas (forward-
// looking only, confirmed against its live docs), this genuinely supports historical
// from/to date-range queries, which is what backtesting needs (see
// fetchHistoricalEconomicEvents below). A separate, paid subscription from TickAtlas --
// not a replacement for it, since TickAtlas still powers the live news_blackout gate.
const FMP_CALENDAR_URL = "https://financialmodelingprep.com/stable/economic-calendar";
// FMP's own documented per-request window cap -- fetchHistoricalEconomicEvents
// paginates across this in slices rather than assuming one call covers an arbitrary
// requested range (a full backtest lookback can be up to 180 days, see
// backtest/constants.ts's MAX_LOOKBACK_DAYS).
const FMP_MAX_RANGE_DAYS = 90;
// A high-impact release inside this window before/around the signal's own candle time
// is enough to hold off -- not a hard science, a conservative default matching the
// "if in doubt, don't trade into a headline" spirit of the user's original request.
const NEWS_WINDOW_MINUTES = 30;

// The currencies this app actually trades (see PAIRS in ./types.ts). checkNews()'s
// pair-leg matching (KNOWN_CURRENCIES, below) is derived from this same list rather
// than hand-duplicated, so the two can never silently drift apart again -- a currency
// requested from TickAtlas but not recognized as a pair leg (or vice versa) would
// otherwise be a quiet "always reports clear" gap for that currency.
const TRACKED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"] as const;
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

/**
 * Parses FMP's /stable/economic-calendar response (confirmed via a live call before
 * building this, same discipline as parseTickAtlasCalendar) -- each entry's own
 * `impact` field ("Low"/"Medium"/"High", capitalized) is normalized to this app's own
 * lowercase EconomicEvent.impact convention, and only "High" entries are kept (this app
 * never gates on medium/low impact -- see checkNews's own news_blackout only ever
 * firing on a genuinely detected HIGH-impact event). `date` is a plain
 * "YYYY-MM-DD HH:mm:ss" string with no timezone suffix -- confirmed UTC by cross-
 * checking real US releases in the response (e.g. Personal Income/Core PCE/GDP all
 * landing at "12:30:00", which is 8:30am US Eastern in July/EDT -- the well-known real
 * release time for those series), not guessed.
 */
export function parseFmpCalendar(json: unknown): EconomicEvent[] {
  if (!Array.isArray(json)) return [];

  const events: EconomicEvent[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.impact !== "string" || entry.impact.toLowerCase() !== "high") continue;
    const currency = typeof entry.currency === "string" ? entry.currency : null;
    const eventName = typeof entry.event === "string" ? entry.event : null;
    const timeMs = typeof entry.date === "string" ? Date.parse(`${entry.date.replace(" ", "T")}Z`) : NaN;
    if (!currency || !eventName || Number.isNaN(timeMs)) continue;

    events.push({ currency, event: eventName, impact: "high", timeMs });
  }
  return events;
}

function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetches every high-impact economic event FMP has on record between `from` and `to`,
 * paginating in FMP_MAX_RANGE_DAYS-sized slices -- used only by the backtester (see
 * backtest/backtestRunner.ts), which needs a real historical record instead of
 * checkNews's own live TickAtlas cache (that cache is forward-looking only and has no
 * historical archive at all, see this module's own FMP_CALENDAR_URL comment). Returns
 * whatever it could fetch rather than throwing on a single failed page -- same "one
 * blip shouldn't cost the whole run" posture as historyLoader.ts's own retry logic,
 * just degrading to a smaller (never fabricated) event set instead of retrying.
 */
export async function fetchHistoricalEconomicEvents(from: Date, to: Date): Promise<EconomicEvent[]> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return [];

  const events: EconomicEvent[] = [];
  let windowStart = from;
  while (windowStart.getTime() < to.getTime()) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + FMP_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000, to.getTime()));
    const url = `${FMP_CALENDAR_URL}?from=${formatDateOnly(windowStart)}&to=${formatDateOnly(windowEnd)}&apikey=${apiKey}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[newsFilter] FMP historical calendar request failed (${response.status}) for ${formatDateOnly(windowStart)}..${formatDateOnly(windowEnd)}`);
      } else {
        events.push(...parseFmpCalendar(await response.json()));
      }
    } catch (error) {
      console.error(`[newsFilter] FMP historical calendar request failed for ${formatDateOnly(windowStart)}..${formatDateOnly(windowEnd)}:`, error);
    }
    windowStart = new Date(windowEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return events;
}

/** Debug snapshot for /api/health, same "presence/health, never a secret value"
 * convention as newsFilterStatus below -- FMP is a separate subscription from
 * TickAtlas, only ever used by the backtester, so it gets its own status rather than
 * being folded into newsFilterStatus's live-cache-specific fields. */
export function historicalNewsFilterStatus(): { configured: boolean } {
  return { configured: Boolean(process.env.FMP_API_KEY) };
}

/** Shared window/currency-matching logic between the live cache read (checkNews) and
 * the historical replay read (checkHistoricalNews) -- both need the exact same "is a
 * high-impact release for one of this pair's currencies within NEWS_WINDOW_MINUTES of
 * atTimeMs" answer, just from a different events source. */
function matchNews(events: EconomicEvent[], pair: Pair, atTimeMs: number): NewsStatus {
  const currencies = currenciesForPair(pair);
  const windowMs = NEWS_WINDOW_MINUTES * 60_000;

  for (const event of events) {
    if (!currencies.includes(event.currency)) continue;
    const diff = event.timeMs - atTimeMs;
    if (diff >= -windowMs && diff <= windowMs) {
      return { status: "high_impact_soon", event: event.event, currency: event.currency, minutesUntil: Math.round(diff / 60_000) };
    }
  }
  return { status: "clear" };
}

/**
 * Historical-replay counterpart to checkNews -- takes an explicit, pre-fetched events
 * array (see fetchHistoricalEconomicEvents, fetched once for the whole backtest window)
 * instead of reading the live TickAtlas cache. Same window/currency-matching logic as
 * checkNews itself (see matchNews) -- unlike checkNews, this never reports
 * "unavailable": an empty/missing events array (no FMP_API_KEY configured, or a
 * genuinely quiet stretch) is indistinguishable from "checked and found nothing", both
 * honestly resolve to "clear" here, since there's no live-cache-population state to be
 * uncertain about the way checkNews has.
 */
export function checkHistoricalNews(events: EconomicEvent[], pair: Pair, atTimeMs: number): NewsStatus {
  return matchNews(events, pair, atTimeMs);
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
