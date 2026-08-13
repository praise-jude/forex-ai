import { describe, expect, it } from "vitest";
import { isPastWeeklyAnchor, isoWeekKey } from "../weeklyDigest";

describe("isoWeekKey", () => {
  it("gives the same key for every day within one ISO week", () => {
    // Monday 2026-08-10 through Sunday 2026-08-16 is one ISO week.
    const monday = isoWeekKey(new Date("2026-08-10T00:00:00Z"));
    const wednesday = isoWeekKey(new Date("2026-08-12T15:30:00Z"));
    const sunday = isoWeekKey(new Date("2026-08-16T23:59:59Z"));
    expect(monday).toBe(wednesday);
    expect(wednesday).toBe(sunday);
  });

  it("gives a different key across a week boundary", () => {
    const sunday = isoWeekKey(new Date("2026-08-16T23:59:59Z"));
    const nextMonday = isoWeekKey(new Date("2026-08-17T00:00:01Z"));
    expect(sunday).not.toBe(nextMonday);
  });

  it("handles the year-boundary edge case (ISO year can differ from calendar year)", () => {
    // 2025-12-29 is a Monday, in ISO week 2026-W01 (not 2025-W53), since the ISO year
    // is determined by whichever calendar year owns that week's Thursday.
    expect(isoWeekKey(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
  });
});

describe("isPastWeeklyAnchor", () => {
  it("is false before Monday 08:00 UTC", () => {
    expect(isPastWeeklyAnchor(new Date("2026-08-10T07:59:59Z"))).toBe(false);
  });

  it("is true from Monday 08:00 UTC onward", () => {
    expect(isPastWeeklyAnchor(new Date("2026-08-10T08:00:00Z"))).toBe(true);
  });

  it("is true on every other day of the week regardless of hour", () => {
    expect(isPastWeeklyAnchor(new Date("2026-08-11T00:00:00Z"))).toBe(true); // Tuesday
    expect(isPastWeeklyAnchor(new Date("2026-08-16T23:59:59Z"))).toBe(true); // Sunday
  });
});
