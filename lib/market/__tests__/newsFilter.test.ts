import { beforeEach, describe, expect, it } from "vitest";
import {
  checkNews,
  parseEconomicCalendar,
  resetNewsFilterForTests,
  setNewsFilterStateForTests,
  type EconomicEvent,
} from "../newsFilter";

describe("parseEconomicCalendar", () => {
  it("parses well-formed entries, mapping the EU country code to EUR", () => {
    const events = parseEconomicCalendar({
      economicCalendar: [
        { country: "US", event: "Non-Farm Payrolls", impact: "high", time: "2026-01-05 13:30:00" },
        { country: "EU", event: "ECB Rate Decision", impact: "high", time: "2026-01-06 12:45:00" },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ currency: "USD", event: "Non-Farm Payrolls", impact: "high" });
    expect(events[1]).toMatchObject({ currency: "EUR", event: "ECB Rate Decision", impact: "high" });
  });

  it("skips malformed entries instead of guessing", () => {
    const events = parseEconomicCalendar({
      economicCalendar: [
        { country: "US", event: "Missing impact", time: "2026-01-05 13:30:00" }, // no impact
        { country: "US", impact: "high", time: "2026-01-05 13:30:00" }, // no event name
        { country: "ZZ", event: "Unknown country", impact: "high", time: "2026-01-05 13:30:00" }, // unmapped currency
        { country: "US", event: "Bad time", impact: "high", time: "not-a-date" },
      ],
    });
    expect(events).toHaveLength(0);
  });

  it("returns an empty array (never throws) on a completely unexpected shape", () => {
    expect(parseEconomicCalendar(null)).toEqual([]);
    expect(parseEconomicCalendar({ error: "You don't have access to this resource." })).toEqual([]);
    expect(parseEconomicCalendar("unexpected string")).toEqual([]);
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
    const events: EconomicEvent[] = [{ currency: "JPY", country: "JP", event: "Tankan Survey", impact: "high", timeMs: now + 5 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("is clear when a matching event exists but isn't high-impact", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", country: "US", event: "Minor release", impact: "low", timeMs: now + 5 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("flags a high-impact event for a matching currency inside the 30-minute window", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", country: "US", event: "Non-Farm Payrolls", impact: "high", timeMs: now + 20 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    const result = checkNews("EUR/USD", now);
    expect(result).toMatchObject({ status: "high_impact_soon", currency: "USD", event: "Non-Farm Payrolls" });
  });

  it("does not flag a high-impact event well outside the window", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", country: "US", event: "CPI", impact: "high", timeMs: now + 6 * 60 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("does not flag a currency irrelevant to the pair (e.g. JPY news for a EUR/USD signal)", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "JPY", country: "JP", event: "BOJ Rate Decision", impact: "high", timeMs: now + 10 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("matches a non-FX USD-denominated pair (XAU/USD) against USD news", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", country: "US", event: "Fed Rate Decision", impact: "high", timeMs: now + 10 * 60_000 }];
    setNewsFilterStateForTests(events, true);
    const result = checkNews("XAU/USD", now);
    expect(result.status).toBe("high_impact_soon");
  });
});
