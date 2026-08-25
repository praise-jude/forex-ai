import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAccountConfigured, retryDelayFromError } from "../metaApiConnection";

// Deliberately a plain object shape, not an SDK class instance -- retryDelayFromError
// duck-types on { metadata: { recommendedRetryTime } } rather than `instanceof
// TooManyRequestsError` (see its own doc comment for why: that class isn't actually a
// real export of "metaapi.cloud-sdk/node" at runtime despite the .d.ts claiming it is).
function rateLimitError(recommendedRetryTime: string | Date): unknown {
  return { status: 429, metadata: { recommendedRetryTime } };
}

const ENV_VARS = ["METAAPI_TOKEN", "METAAPI_ACCOUNT_ID", "METAAPI_DEMO_TOKEN", "METAAPI_DEMO_ACCOUNT_ID"];

// Only isAccountConfigured is unit tested here (pure env-var presence check) -- the rest
// of this module holds the real MetaApi SDK connection and is verified against live/demo
// accounts instead, per the project's existing convention (see README's "Manual
// execution" section).
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
