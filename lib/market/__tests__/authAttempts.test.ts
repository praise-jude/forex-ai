import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordFailedDashboardAuth, resetAuthAttemptsForTests } from "../authAttempts";

describe("recordFailedDashboardAuth", () => {
  beforeEach(() => {
    resetAuthAttemptsForTests();
    vi.useRealTimers();
  });

  it("does not notify before the threshold is reached", () => {
    for (let i = 0; i < 4; i++) {
      expect(recordFailedDashboardAuth("1.2.3.4")).toBe(false);
    }
  });

  it("notifies once the 5th failure from the same IP lands within the window", () => {
    for (let i = 0; i < 4; i++) recordFailedDashboardAuth("1.2.3.4");
    expect(recordFailedDashboardAuth("1.2.3.4")).toBe(true);
  });

  it("does not re-notify on every subsequent failure once already reported", () => {
    for (let i = 0; i < 4; i++) recordFailedDashboardAuth("1.2.3.4");
    expect(recordFailedDashboardAuth("1.2.3.4")).toBe(true);
    expect(recordFailedDashboardAuth("1.2.3.4")).toBe(false);
    expect(recordFailedDashboardAuth("1.2.3.4")).toBe(false);
  });

  it("tracks each IP independently", () => {
    for (let i = 0; i < 4; i++) recordFailedDashboardAuth("1.2.3.4");
    expect(recordFailedDashboardAuth("5.6.7.8")).toBe(false);
  });

  it("only counts failures within the rolling window", () => {
    vi.useFakeTimers();
    const start = Date.now();
    for (let i = 0; i < 4; i++) recordFailedDashboardAuth("1.2.3.4");
    vi.setSystemTime(start + 6 * 60 * 1000);
    // The 4 earlier failures have aged out, so this 5th attempt is really only the 1st.
    expect(recordFailedDashboardAuth("1.2.3.4")).toBe(false);
    vi.useRealTimers();
  });
});
