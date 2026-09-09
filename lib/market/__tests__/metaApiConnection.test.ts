import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAccountConfigured, isPairTimeframeStale, retryDelayFromError } from "../metaApiConnection";
import { candleStore } from "../candleStore";

// Deliberately a plain object shape, not an SDK class instance -- retryDelayFromError
// duck-types on { metadata: { recommendedRetryTime } } rather than `instanceof
// TooManyRequestsError` (see its own doc comment for why: that class isn't actually a
// real export of "metaapi.cloud-sdk/node" at runtime despite the .d.ts claiming it is).
function rateLimitError(recommendedRetryTime: string | Date): unknown {
  return { status: 429, metadata: { recommendedRetryTime } };
}

const ENV_VARS = ["METAAPI_TOKEN", "METAAPI_ACCOUNT_ID", "METAAPI_DEMO_TOKEN", "METAAPI_DEMO_ACCOUNT_ID"];

// isAccountConfigured, retryDelayFromError, and isPairTimeframeStale are unit tested
// here (all pure, or pure-enough with a real in-memory store) -- the rest of this module
// holds the real MetaApi SDK connection and is verified against live/demo accounts
// instead, per the project's existing convention (see README's "Manual execution"
// section).
describe("isAccountConfigured", () => {
  // Cleared both before AND after each test -- vitest.setup.ts loads the real
  // .env.local globally now (needed for lib/account/__tests__/sessions.test.ts's own
  // real-database tests), which would otherwise leak this repo's real MetaApi
  // credentials into the "nothing set" case below.
  beforeEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  it("is false when neither var is set", () => {
    expect(isAccountConfigured("live")).toBe(false);
    expect(isAccountConfigured("demo")).toBe(false);
  });

  it("is true only once both token and account id are set, per account", () => {
    process.env.METAAPI_TOKEN = "token";
    expect(isAccountConfigured("live")).toBe(false); // account id still missing
    process.env.METAAPI_ACCOUNT_ID = "account-id";
    expect(isAccountConfigured("live")).toBe(true);
    expect(isAccountConfigured("demo")).toBe(false); // live being configured doesn't imply demo is
  });

  it("demo configuration is independent of live", () => {
    process.env.METAAPI_DEMO_TOKEN = "demo-token";
    process.env.METAAPI_DEMO_ACCOUNT_ID = "demo-account-id";
    expect(isAccountConfigured("demo")).toBe(true);
    expect(isAccountConfigured("live")).toBe(false);
  });
});

describe("retryDelayFromError", () => {
  it("returns the fallback for an error with no rate-limit shape", () => {
    expect(retryDelayFromError(new Error("boom"), 12_345)).toBe(12_345);
  });

  it("returns the fallback when recommendedRetryTime doesn't parse", () => {
    const error = rateLimitError("not-a-date");
    expect(retryDelayFromError(error, 12_345)).toBe(12_345);
  });

  it("clamps to a 10s floor for a retry time already in the past", () => {
    const error = rateLimitError(new Date(Date.now() - 60_000));
    expect(retryDelayFromError(error, 0)).toBe(10_000);
  });

  it("clamps to a 20min ceiling for a far-future retry time", () => {
    const error = rateLimitError(new Date(Date.now() + 60 * 60 * 1000));
    expect(retryDelayFromError(error, 0)).toBe(20 * 60 * 1000);
  });

  it("uses the real recommended delay when it falls within bounds", () => {
    const error = rateLimitError(new Date(Date.now() + 90_000));
    const delay = retryDelayFromError(error, 0);
    expect(delay).toBeGreaterThan(85_000);
    expect(delay).toBeLessThanOrEqual(90_000);
  });
});

const FIFTEEN_MIN_MS = 15 * 60_000;

function candleAt(time: number) {
  return { time, open: 1, high: 1, low: 1, close: 1, tickVolume: 1 };
}

describe("isPairTimeframeStale", () => {
  it("is false when the last CLOSED candle is recent, even with a fresh-looking forming candle on top", () => {
    // Real bug fixed 2026-09-09: this used to check the RAW last candle (which can be
    // the still-forming current bar, whose `time` is its OPEN time and looks "recent"
    // regardless of whether real ticks are still arriving). Both entries here are within
    // the window either way -- this just confirms the ordinary, healthy case still reads
    // as fresh.
    const now = Date.now();
    candleStore.seed("EUR/USD", "15m", [candleAt(now - FIFTEEN_MIN_MS), candleAt(now - 60_000)]);
    expect(isPairTimeframeStale("EUR/USD", "15m")).toBe(false);
  });

  it("is true when the last CLOSED candle is stale, even though the raw last (forming) entry alone would look fresh -- the real bug this fixes", () => {
    const now = Date.now();
    // The "forming" candle opened only 2 minutes ago (looks fresh by itself), but the
    // candle before it -- the actual last CLOSED bar -- opened 35 minutes ago, well past
    // the 30-minute (2x15m) threshold. A genuinely dead subscription frozen on this same
    // forming candle for the last 33 minutes would look exactly like this.
    candleStore.seed("EUR/USD", "15m", [candleAt(now - 35 * 60_000), candleAt(now - 2 * 60_000)]);
    expect(isPairTimeframeStale("EUR/USD", "15m")).toBe(true);
  });

  it("is true when there's only one candle total -- nothing closed yet to check", () => {
    candleStore.seed("EUR/USD", "15m", [candleAt(Date.now())]);
    expect(isPairTimeframeStale("EUR/USD", "15m")).toBe(true);
  });

  it("is true when there's no data at all for this pair/timeframe", () => {
    candleStore.seed("EUR/USD", "15m", []);
    expect(isPairTimeframeStale("EUR/USD", "15m")).toBe(true);
  });
});
