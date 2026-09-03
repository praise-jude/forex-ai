import { describe, expect, it } from "vitest";
import { formatDurationApprox } from "../format";

describe("formatDurationApprox", () => {
  it("shows minutes only under an hour", () => {
    expect(formatDurationApprox(5 * 60_000)).toBe("5m");
  });

  it("shows hours and minutes under a day", () => {
    expect(formatDurationApprox(2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("shows days and hours at 24h or beyond", () => {
    expect(formatDurationApprox(26 * 60 * 60_000)).toBe("1d 2h");
  });

  it("clamps a negative duration to zero rather than showing a negative reading", () => {
    expect(formatDurationApprox(-5000)).toBe("0m");
  });
});
