import { describe, expect, it } from "vitest";
import { formatCountdown, getAllSessionStatuses, getOverlapLabel, getSessionStatus } from "../marketSessions";

describe("marketSessions", () => {
  describe("London -- DST-aware via Europe/London", () => {
    it("is open right at 08:00 local during GMT winter (08:00 UTC)", () => {
      const utcMs = Date.UTC(2026, 0, 15, 8, 0, 0); // Jan 15, 2026 -- GMT (UTC+0)
      expect(getSessionStatus("london", utcMs).isOpen).toBe(true);
    });

    it("is closed one minute before 08:00 local during GMT winter", () => {
      const utcMs = Date.UTC(2026, 0, 15, 7, 59, 0);
      expect(getSessionStatus("london", utcMs).isOpen).toBe(false);
    });

    it("is open at 07:00 UTC during BST summer, when a fixed +0 offset would wrongly say closed", () => {
      const utcMs = Date.UTC(2026, 6, 15, 7, 0, 0); // Jul 15, 2026 -- BST (UTC+1) -- 07:00 UTC = 08:00 local
      expect(getSessionStatus("london", utcMs).isOpen).toBe(true);
    });

    it("is closed at 06:00 UTC during BST summer (07:00 local, before the 08:00 open)", () => {
      const utcMs = Date.UTC(2026, 6, 15, 6, 0, 0);
      expect(getSessionStatus("london", utcMs).isOpen).toBe(false);
    });
  });

  describe("New York -- DST-aware via America/New_York", () => {
    it("is open at 13:00 UTC during EST winter (08:00 local)", () => {
      const utcMs = Date.UTC(2026, 0, 15, 13, 0, 0);
      expect(getSessionStatus("newyork", utcMs).isOpen).toBe(true);
    });

    it("is closed at 12:00 UTC during EST winter (07:00 local)", () => {
      const utcMs = Date.UTC(2026, 0, 15, 12, 0, 0);
      expect(getSessionStatus("newyork", utcMs).isOpen).toBe(false);
    });

    it("is open at 12:00 UTC during EDT summer, when a fixed -5 offset would wrongly say closed", () => {
      const utcMs = Date.UTC(2026, 6, 15, 12, 0, 0); // EDT (UTC-4) -- 12:00 UTC = 08:00 local
      expect(getSessionStatus("newyork", utcMs).isOpen).toBe(true);
    });

    it("is closed at 11:00 UTC during EDT summer (07:00 local)", () => {
      const utcMs = Date.UTC(2026, 6, 15, 11, 0, 0);
      expect(getSessionStatus("newyork", utcMs).isOpen).toBe(false);
    });
  });

  describe("Sydney -- DST-aware via Australia/Sydney, midnight-crossing window", () => {
    it("is open at 11:00 UTC during AEDT summer (22:00 local -- the window's own start hour)", () => {
      const utcMs = Date.UTC(2026, 0, 15, 11, 0, 0); // Jan -- AEDT (UTC+11) -- 11:00 UTC = 22:00 local
      expect(getSessionStatus("sydney", utcMs).isOpen).toBe(true);
    });

    it("is closed at the same 11:00 UTC during AEST winter, when AEDT's offset would wrongly say open", () => {
      const utcMs = Date.UTC(2026, 6, 15, 11, 0, 0); // Jul -- AEST (UTC+10) -- 11:00 UTC = 21:00 local
      expect(getSessionStatus("sydney", utcMs).isOpen).toBe(false);
    });

    it("stays open past local midnight (spanning into the next calendar day)", () => {
      const utcMs = Date.UTC(2026, 0, 15, 15, 0, 0); // AEDT -- 15:00 UTC = 02:00 local (next day)
      const status = getSessionStatus("sydney", utcMs);
      expect(status.isOpen).toBe(true);
    });

    it("counts down to the close transition correctly while spanning midnight", () => {
      const utcMs = Date.UTC(2026, 0, 15, 15, 0, 0); // 02:00 local, open, closes at 07:00 local (~5h away)
      const status = getSessionStatus("sydney", utcMs);
      expect(status.nextTransition).toBe("close");
      const fiveHoursMs = 5 * 60 * 60_000;
      expect(Math.abs(status.msUntilTransition - fiveHoursMs)).toBeLessThan(2 * 60_000);
    });
  });

  describe("Tokyo -- no DST, fixed UTC window", () => {
    it("is open at 01:00 UTC regardless of the time of year", () => {
      const winterMs = Date.UTC(2026, 0, 15, 1, 0, 0);
      const summerMs = Date.UTC(2026, 6, 15, 1, 0, 0);
      expect(getSessionStatus("tokyo", winterMs).isOpen).toBe(true);
      expect(getSessionStatus("tokyo", summerMs).isOpen).toBe(true);
      expect(getSessionStatus("tokyo", winterMs).localWindowLabel).toBe(getSessionStatus("tokyo", summerMs).localWindowLabel);
    });

    it("is closed at 12:00 UTC regardless of the time of year", () => {
      const winterMs = Date.UTC(2026, 0, 15, 12, 0, 0);
      const summerMs = Date.UTC(2026, 6, 15, 12, 0, 0);
      expect(getSessionStatus("tokyo", winterMs).isOpen).toBe(false);
      expect(getSessionStatus("tokyo", summerMs).isOpen).toBe(false);
    });
  });

  describe("getOverlapLabel", () => {
    it("is non-null and names both sessions during the London/New York overlap", () => {
      const utcMs = Date.UTC(2026, 0, 15, 14, 0, 0); // winter: London 14:00 local, NY 09:00 local -- both open
      const overlap = getOverlapLabel(getAllSessionStatuses(utcMs));
      expect(overlap).not.toBeNull();
      expect(overlap).toContain("London");
      expect(overlap).toContain("New York");
    });

    it("is null when only a single session is open", () => {
      const utcMs = Date.UTC(2026, 0, 15, 5, 0, 0); // only Tokyo open at this instant
      const statuses = getAllSessionStatuses(utcMs);
      expect(statuses.filter((s) => s.isOpen)).toHaveLength(1);
      expect(getOverlapLabel(statuses)).toBeNull();
    });
  });

  describe("formatCountdown", () => {
    it("formats hours and minutes", () => {
      expect(formatCountdown(2 * 60 * 60_000 + 41 * 60_000)).toBe("2h 41m");
    });

    it("omits the hour part when under an hour", () => {
      expect(formatCountdown(45 * 60_000)).toBe("45m");
    });
  });
});
