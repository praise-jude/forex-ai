import { beforeEach, describe, expect, it } from "vitest";
import { checkNews, parseFredReleaseDates, resetNewsFilterForTests, setNewsFilterStateForTests, type EconomicEvent } from "../newsFilter";

describe("parseFredReleaseDates", () => {
  it("parses well-formed entries on the curated allowlist", () => {
    const events = parseFredReleaseDates({
      release_dates: [
        { release_id: 50, release_name: "Employment Situation", date: "2026-01-05" },
        { release_id: 10, release_name: "Consumer Price Index", date: "2026-01-06" },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ currency: "USD", event: "Employment Situation", date: "2026-01-05" });
    expect(events[1]).toEqual({ currency: "USD", event: "Consumer Price Index", date: "2026-01-06" });
  });

  it("excludes 'FOMC Press Release' -- live-verified to fire on nearly every day (~38 dates/3mo), not real meeting dates, so it must never be treated as a curated high-impact event", () => {
    const events = parseFredReleaseDates({
      release_dates: [{ release_id: 101, release_name: "FOMC Press Release", date: "2026-08-11" }],
    });
    expect(events).toHaveLength(0);
  });

  it("skips releases not on the curated high-impact allowlist", () => {
    const events = parseFredReleaseDates({
      release_dates: [{ release_id: 200, release_name: "CBOE Market Statistics", date: "2026-01-05" }],
    });
    expect(events).toHaveLength(0);
  });

  it("does not match GDP variant releases against the headline 'Gross Domestic Product' entry", () => {
    const events = parseFredReleaseDates({
      release_dates: [
        { release_id: 1, release_name: "Gross Domestic Product by State", date: "2026-01-05" },
        { release_id: 2, release_name: "Gross Domestic Product by Industry", date: "2026-01-05" },
        { release_id: 3, release_name: "Gross Domestic Product", date: "2026-01-05" },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("Gross Domestic Product");
  });

  it("skips malformed entries instead of guessing", () => {
    const events = parseFredReleaseDates({
      release_dates: [
        { release_id: 50, date: "2026-01-05" }, // no release_name
        { release_id: 50, release_name: "Employment Situation" }, // no date
      ],
    });
    expect(events).toHaveLength(0);
  });

  it("returns an empty array (never throws) on a completely unexpected shape", () => {
    expect(parseFredReleaseDates(null)).toEqual([]);
    expect(parseFredReleaseDates({ error_message: "Bad Request." })).toEqual([]);
    expect(parseFredReleaseDates("unexpected string")).toEqual([]);
  });
});

describe("checkNews", () => {
  beforeEach(() => {
    resetNewsFilterForTests();
  });

  it("is unavailable when the cache has never been successfully populated", () => {
    expect(checkNews("EUR/USD", Date.now())).toEqual({ status: "unavailable" });
  });

  it("is clear when no curated event matches the same UTC day", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Consumer Price Index", date: "2026-01-06" }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "clear" });
  });

  it("flags a curated event scheduled for the same UTC day, with no minutesUntil (day-level only)", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Employment Situation", date: "2026-01-05" }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("EUR/USD", now)).toEqual({ status: "high_impact_today", event: "Employment Situation", currency: "USD" });
  });

  it("flags any pair with a USD leg, in either position", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Employment Situation", date: "2026-01-05" }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("GBP/USD", now)).toEqual({ status: "high_impact_today", event: "Employment Situation", currency: "USD" });
    expect(checkNews("USD/JPY", now)).toEqual({ status: "high_impact_today", event: "Employment Situation", currency: "USD" });
  });

  it("never fires for a pair with no USD leg -- FRED has no non-USD coverage (USOIL has no '/' to extract a currency from at all, matching this app's pre-existing pair-naming convention)", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Employment Situation", date: "2026-01-05" }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("USOIL", now)).toEqual({ status: "clear" });
  });

  it("matches a non-FX USD-denominated instrument (XAU/USD) against USD releases", () => {
    const now = Date.UTC(2026, 0, 5, 13, 0, 0);
    const events: EconomicEvent[] = [{ currency: "USD", event: "Consumer Price Index", date: "2026-01-05" }];
    setNewsFilterStateForTests(events, true);
    expect(checkNews("XAU/USD", now).status).toBe("high_impact_today");
  });
});
