import type { Pair } from "./types";

const FRED_URL = "https://api.stlouisfed.org/fred/releases/dates";
// FRED's own release schedule doesn't shift minute to minute -- 6h keeps same-day
// additions caught well before market open without polling more than useful. Far more
// conservative than needed against FRED's genuinely generous free-tier rate limits.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOOKAHEAD_DAYS = 7;

// FRED (St. Louis Fed) has no per-event impact-level field and no time-of-day --
// only a calendar date. This hand-curated allowlist of release NAMES stands in for
// "high impact", live-verified against FRED's actual /fred/releases list AND checked
// for a sane cadence (not guessed, not just present) -- the standard "red folder" USD
// releases. Exact-string match: FRED also has "Gross Domestic Product by
// County/Industry/State", which must NOT match the headline "Gross Domestic Product"
// release.
//
// Deliberately excludes "FOMC Press Release" (release_id 101): live-verified over a
// 3-month window to return ~38 dates -- every single day in the surrounding stretch,
// not the actual ~8-per-year meeting schedule. No other FOMC-meeting-specific release
// exists in FRED's catalog (checked the full /fred/releases list). This is a real,
// known gap -- Fed rate-decision days are NOT covered by this filter at all, unlike
// every other release below, which was verified to fire once (monthly) or twice
// (quarterly) per 3-month window, matching its real-world cadence.
const HIGH_IMPACT_RELEASE_NAMES = new Set([
  "Employment Situation", // NFP
  "Consumer Price Index", // CPI
  "Gross Domestic Product", // GDP
  "Personal Income and Outlays", // PCE -- the Fed's preferred inflation gauge
  "Producer Price Index", // PPI
  "Advance Monthly Sales for Retail and Food Services", // Retail Sales
]);

export interface EconomicEvent {
  /** Always "USD" -- FRED only covers US releases, so this is never fabricated for
   * any other currency (see checkNews's own comment). Kept as a field (not a bare
   * constant) so the shape stays parallel to how a multi-currency source would look. */
  currency: "USD";
  event: string;
  /** UTC calendar day only (YYYY-MM-DD) -- FRED has no time-of-day field anywhere in
   * its schema (confirmed live against /fred/release?release_id=50, the Employment
   * Situation/NFP release, before building this). checkNews() can only ever ask "is
   * this the same day", never "how many minutes away". */
  date: string;
}

export type NewsStatus =
  | { status: "clear" }
  | { status: "high_impact_today"; event: string; currency: "USD" }
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

/**
 * Only ever matches "USD" -- a EUR/USD or USD/JPY signal's non-USD leg (EUR, JPY, ...)
 * is never checked against anything, since FRED has no data for it. Reuses the pair's
 * own "/"-split legs the same way the rest of this app already does (see
 * currencyStrength.ts), just narrowed to the one currency this source can speak to.
 */
function pairHasUsdLeg(pair: Pair): boolean {
  return pair.split("/").includes("USD");
}

/**
 * Parses FRED's documented /fred/releases/dates response shape
 * (`{ release_dates: [{ release_id, release_name, date }] }`, confirmed via a live
 * call during implementation) defensively -- any entry that doesn't match the
 * expected fields, or whose release_name isn't on the curated allowlist, is skipped
 * rather than guessed at. A completely unexpected top-level shape empties the result
 * rather than throwing.
 */
export function parseFredReleaseDates(json: unknown): EconomicEvent[] {
  if (typeof json !== "object" || json === null || !("release_dates" in json)) return [];
  const raw = (json as { release_dates: unknown }).release_dates;
  if (!Array.isArray(raw)) return [];

  const events: EconomicEvent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const releaseName = typeof entry.release_name === "string" ? entry.release_name : null;
    const date = typeof entry.date === "string" ? entry.date : null;
    if (!releaseName || !date || !HIGH_IMPACT_RELEASE_NAMES.has(releaseName)) continue;

    events.push({ currency: "USD", event: releaseName, date });
  }
  return events;
}

function todayPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function refreshOnce(): Promise<void> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    state.lastFetchOk = false;
    return;
  }

  const realtimeStart = todayPlusDays(0);
  const realtimeEnd = todayPlusDays(LOOKAHEAD_DAYS);

  try {
    const url = `${FRED_URL}?api_key=${apiKey}&file_type=json&realtime_start=${realtimeStart}&realtime_end=${realtimeEnd}&include_release_dates_with_no_data=true&limit=1000`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[newsFilter] FRED request failed (${response.status}): ${await response.text().catch(() => "")}`);
      state.lastFetchOk = false;
      return;
    }
    const json = await response.json();
    state.events = parseFredReleaseDates(json);
    state.lastFetchOk = true;
  } catch (error) {
    console.error("[newsFilter] FRED request failed:", error);
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
 * "high_impact_today" only ever fires for a pair's USD leg, and only names the
 * calendar day, never a countdown -- FRED has no finer-grained data to report (see
 * EconomicEvent's own comment).
 */
export function checkNews(pair: Pair, atTimeMs: number): NewsStatus {
  if (state.lastFetchOk !== true) return { status: "unavailable" };
  if (!pairHasUsdLeg(pair)) return { status: "clear" };

  const today = new Date(atTimeMs).toISOString().slice(0, 10);
  const match = state.events.find((event) => event.date === today);
  if (match) return { status: "high_impact_today", event: match.event, currency: match.currency };
  return { status: "clear" };
}

/** Used by tests to reset cache state between cases. */
export function resetNewsFilterForTests(): void {
  state.events = [];
  state.lastFetchOk = null;
  state.started = false;
}

/** Used by tests to seed the cache directly, bypassing the network fetch --
 * checkNews()'s day-matching logic is what's under test, not FRED connectivity
 * itself. */
export function setNewsFilterStateForTests(events: EconomicEvent[], lastFetchOk: boolean): void {
  state.events = events;
  state.lastFetchOk = lastFetchOk;
}

/** Debug snapshot for /api/health -- reports presence/health, never a secret value
 * itself (same convention as getConnectionStatus in metaApiConnection.ts). */
export function newsFilterStatus(): { configured: boolean; lastFetchOk: boolean | null; eventCount: number } {
  return {
    configured: Boolean(process.env.FRED_API_KEY),
    lastFetchOk: state.lastFetchOk,
    eventCount: state.events.length,
  };
}
