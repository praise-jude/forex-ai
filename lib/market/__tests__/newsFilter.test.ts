import { beforeEach, describe, expect, it } from "vitest";
import { checkNews, parseTickAtlasCalendar, resetNewsFilterForTests, setNewsFilterStateForTests, type EconomicEvent } from "../newsFilter";

describe("parseTickAtlasCalendar", () => {
  it("parses well-formed high-impact entries", () => {
    const events = parseTickAtlasCalendar({
      success: true,
      data: {
        events: [
          { id: "1", datetime: "2026-01-05T13:30:00+00:00", currency: "USD", event: "Non-Farm Payrolls", impact: "high", forecast: "195K", previous: "187K", actual: null },
          { id: "2", datetime: "2026-01-06T12:45:00+00:00", currency: "EUR", event: "ECB Rate Decision", impact: "high", forecast: null, previous: null, actual: null },
        ],
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ currency: "USD", event: "Non-Farm Payrolls", impact: "high" });
    expect(events[1]).toMatchObject({ currency: "EUR", event: "ECB Rate Decision", impact: "high" });
  });

  it("skips non-high-impact entries even though the request already asks for impact=high server-side", () => {
    const events = parseTickAtlasCalendar({
      success: true,
      data: { events: [{ id: "1", datetime: "2026-01-05T13:30:00+00:00", currency: "USD", event: "Minor release", impact: "low" }] },
    });
    expect(events).toHaveLength(0);
  });

  it("skips malformed entries instead of guessing", () => {
    const events = parseTickAtlasCalendar({
      success: true,
      data: {
        events: [
          { id: "1", currency: "USD", event: "Missing datetime", impact: "high" },
          { id: "2", datetime: "2026-01-05T13:30:00+00:00", event: "Missing currency", impact: "high" },
          { id: "3", datetime: "2026-01-05T13:30:00+00:00", currency: "USD", impact: "high" }, // no event name
          { id: "4", datetime: "not-a-date", currency: "USD", event: "Bad datetime", impact: "high" },
        ],
      },
    });
    expect(events).toHaveLength(0);
  });

  it("returns an empty array (never throws) on a completely unexpected shape", () => {
    expect(parseTickAtlasCalendar(null)).toEqual([]);
    expect(parseTickAtlasCalendar({ success: false, error: "invalid api key" })).toEqual([]);
    expect(parseTickAtlasCalendar("unexpected string")).toEqual([]);
    expect(parseTickAtlasCalendar({ success: true, data: {} })).toEqual([]);
  });
});

describe("checkNews", () => {
  beforeEach(() => {
    resetNewsFilterForTests();
  });

  it("is unavailable when the cache has never been successfully populated", () => {
    expect(checkNews("EUR/USD", Date.now())).toEqual({ status: "unavailable" });
  });

  it("is clear when no high-impact event matches the pair's currencies", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "JPY", event: "Tankan Survey", impact: "high", timeMs: now + 5 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("flags a high-impact event for a matching currency inside the 30-minute window", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Non-Farm Payrolls", impact: "high", timeMs: now + 20 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    const result = checkNews("EUR/USD", now);
    expect(result).toMatchObject({ status: "high_impact_soon", currency: "USD", event: "Non-Farm Payrolls", minutesUntil: 20 });
  });

  it("does not flag a high-impact event well outside the window", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "CPI", impact: "high", timeMs: now + 6 * 60 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("does not flag a currency irrelevant to the pair (e.g. JPY news for a EUR/USD signal)", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "JPY", event: "BOJ Rate Decision", impact: "high", timeMs: now + 10 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("matches a non-FX USD-denominated pair (XAU/USD) against USD news", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Fed Rate Decision", impact: "high", timeMs: now + 10 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    const result = checkNews("XAU/USD", now);
    expect(result.status).toBe("high_impact_soon");
  });

  it("matches the non-USD leg too (e.g. EUR news for a EUR/USD signal), unlike the prior USD-only data source", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "EUR", event: "ECB Rate Decision", impact: "high", timeMs: now + 10 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toMatchObject({ status: "high_impact_soon", currency: "EUR" });
  });
});
