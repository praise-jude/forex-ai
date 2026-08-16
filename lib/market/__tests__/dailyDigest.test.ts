import { describe, expect, it } from "vitest";
import { isPastDailyAnchor, isoDayKey } from "../dailyDigest";

describe("isoDayKey", () => {
  it("gives the same key for every moment within one UTC calendar day", () => {
    const morning = isoDayKey(new Date("2026-08-16T00:00:00Z"));
    const evening = isoDayKey(new Date("2026-08-16T20:30:00Z"));
    const lastMoment = isoDayKey(new Date("2026-08-16T23:59:59Z"));
    expect(morning).toBe(evening);
    expect(evening).toBe(lastMoment);
  });

  it("gives a different key across a day boundary", () => {
    const today = isoDayKey(new Date("2026-08-16T23:59:59Z"));
    const tomorrow = isoDayKey(new Date("2026-08-17T00:00:01Z"));
    expect(today).not.toBe(tomorrow);
  });
});

describe("isPastDailyAnchor", () => {
  it("is false before 20:00 UTC", () => {
    expect(isPastDailyAnchor(new Date("2026-08-16T19:59:59Z"))).toBe(false);
  });

  it("is true from 20:00 UTC through the rest of the day", () => {
    expect(isPastDailyAnchor(new Date("2026-08-16T20:00:00Z"))).toBe(true);
    expect(isPastDailyAnchor(new Date("2026-08-16T23:59:59Z"))).toBe(true);
  });
});
