import type { Pair } from "./types";

const FINNHUB_URL = "https://finnhub.io/api/v1/calendar/economic";
const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 min -- calendar entries don't need second-by-second freshness
const LOOKAHEAD_DAYS = 3;
// A high-impact release inside this window before/around the signal's own candle time
// is enough to hold off -- not a hard science, a conservative default matching the
// "if in doubt, don't trade into a headline" spirit of the user's request.
const NEWS_WINDOW_MINUTES = 30;

const KNOWN_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]);

// Finnhub's economic calendar keys events by 2-letter COUNTRY code, not currency code --
// most don't share letters with their currency at all (US->USD, GB->GBP), so this can't
// be inferred, only mapped explicitly. "EU" covers pan-eurozone releases (e.g. ECB);
// individual eurozone members (DE, FR, IT, ES, ...) also map to EUR since a release
// tagged to Germany/France still moves the euro.
const COUNTRY_TO_CURRENCY: Record<string, string> = {
  US: "USD",
  EU: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  GB: "GBP",
  JP: "JPY",
  AU: "AUD",
  CA: "CAD",
  CH: "CHF",
  NZ: "NZD",
};

export interface EconomicEvent {
  currency: string;
  country: string;
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
 * Parses Finnhub's documented /calendar/economic response shape defensively -- this
 * project's API key does not currently have access to this endpoint (confirmed via a
 * live test call; Finnhub gates it behind a paid plan), so the exact response shape is
 * UNVERIFIED against a real successful response. Any entry that doesn't match the
 * expected fields is skipped rather than guessed at; a completely unexpected top-level
 * shape empties the cache rather than throwing. Re-verify this parsing against a real
 * response once the account upgrade lands.
 */
export function parseEconomicCalendar(json: unknown): EconomicEvent[] {
  if (typeof json !== "object" || json === null || !("economicCalendar" in json)) return [];
  const raw = (json as { economicCalendar: unknown }).economicCalendar;
  if (!Array.isArray(raw)) return [];

  const events: EconomicEvent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const impact = entry.impact;
    if (impact !== "high" && impact !== "medium" && impact !== "low") continue;
    const country = typeof entry.country === "string" ? entry.country : null;
    const eventName = typeof entry.event === "string" ? entry.event : null;
    const timeMs = typeof entry.time === "string" ? Date.parse(entry.time) : NaN;
    if (!country || !eventName || Number.isNaN(timeMs)) continue;

    const currency = COUNTRY_TO_CURRENCY[country];
    if (!currency) continue;

    events.push({ currency, country, event: eventName, impact, timeMs });
  }
  return events;
}

async function refreshOnce(): Promise<void> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    state.lastFetchOk = false;
    return;
  }

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + LOOKAHEAD_DAYS * 86_400_000).toISOString().slice(0, 10);

  try {
    const response = await fetch(`${FINNHUB_URL}?from=${from}&to=${to}&token=${apiKey}`);
    if (!response.ok) {
      console.error(`[newsFilter] Finnhub request failed (${response.status}): ${await response.text().catch(() => "")}`);
      state.lastFetchOk = false;
      return;
    }
    const json = await response.json();
    state.events = parseEconomicCalendar(json);
    state.lastFetchOk = true;
  } catch (error) {
    console.error("[newsFilter] Finnhub request failed:", error);
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
 * no access on the current plan, network failure, or simply not started) -- never
 * reports "clear" as a guess.
 */
export function checkNews(pair: Pair, atTimeMs: number): NewsStatus {
  if (state.lastFetchOk !== true) return { status: "unavailable" };

  const currencies = currenciesForPair(pair);
  const windowMs = NEWS_WINDOW_MINUTES * 60_000;

  for (const event of state.events) {
    if (event.impact !== "high") continue;
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
 * checkNews()'s window/currency-matching logic is what's under test, not Finnhub
 * connectivity itself. */
export function setNewsFilterStateForTests(events: EconomicEvent[], lastFetchOk: boolean): void {
  state.events = events;
  state.lastFetchOk = lastFetchOk;
}
