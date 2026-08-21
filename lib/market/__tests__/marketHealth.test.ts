import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_THRESHOLD_MS, isPriceStale, isTickStale } from "../marketHealth";
import type { Price } from "../types";

function price(overrides: Partial<Price> = {}): Price {
  return { pair: "EUR/USD", bid: 1.105, ask: 1.1052, time: 1000, ...overrides };
}

describe("isPriceStale", () => {
  it("is not stale when the last tick is within the threshold", () => {
    const now = 1000 + DEFAULT_STALE_THRESHOLD_MS - 1;
    expect(isPriceStale(price({ time: 1000 }), now)).toBe(false);
  });

  it("is stale once the last tick is older than the threshold", () => {
    const now = 1000 + DEFAULT_STALE_THRESHOLD_MS + 1;
    expect(isPriceStale(price({ time: 1000 }), now)).toBe(true);
  });

  it("treats exactly the threshold as not yet stale (strictly greater-than)", () => {
    const now = 1000 + DEFAULT_STALE_THRESHOLD_MS;
    expect(isPriceStale(price({ time: 1000 }), now)).toBe(false);
  });

  it("is stale when there's no price at all", () => {
    expect(isPriceStale(undefined, 1000)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isPriceStale(price({ time: 1000 }), 1500, 1000)).toBe(false);
    expect(isPriceStale(price({ time: 1000 }), 2500, 1000)).toBe(true);
  });
});

describe("isTickStale", () => {
  it("mirrors isPriceStale's threshold logic for a bare timestamp", () => {
    expect(isTickStale(1000, 1000 + DEFAULT_STALE_THRESHOLD_MS - 1)).toBe(false);
    expect(isTickStale(1000, 1000 + DEFAULT_STALE_THRESHOLD_MS + 1)).toBe(true);
  });

  it("is stale when there's no timestamp at all (null or undefined)", () => {
    expect(isTickStale(null, 1000)).toBe(true);
    expect(isTickStale(undefined, 1000)).toBe(true);
  });
});
