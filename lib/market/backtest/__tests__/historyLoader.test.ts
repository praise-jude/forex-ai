import { describe, expect, it } from "vitest";
import { isRetryableFetchError, resolveBacktestCredentials } from "../historyLoader";

describe("resolveBacktestCredentials", () => {
  it("prefers demo credentials when both live and demo are configured", () => {
    const result = resolveBacktestCredentials({
      METAAPI_TOKEN: "live-token",
      METAAPI_ACCOUNT_ID: "live-account",
      METAAPI_DEMO_TOKEN: "demo-token",
      METAAPI_DEMO_ACCOUNT_ID: "demo-account",
    });
    expect(result).toEqual({ token: "demo-token", accountId: "demo-account" });
  });

  it("falls back to live credentials when demo isn't configured", () => {
    const result = resolveBacktestCredentials({
      METAAPI_TOKEN: "live-token",
      METAAPI_ACCOUNT_ID: "live-account",
    });
    expect(result).toEqual({ token: "live-token", accountId: "live-account" });
  });

  it("falls back to live when only a partial demo config is present (token but no account id)", () => {
    const result = resolveBacktestCredentials({
      METAAPI_TOKEN: "live-token",
      METAAPI_ACCOUNT_ID: "live-account",
      METAAPI_DEMO_TOKEN: "demo-token",
    });
    expect(result).toEqual({ token: "live-token", accountId: "live-account" });
  });

  it("throws when neither live nor demo credentials are configured", () => {
    expect(() => resolveBacktestCredentials({})).toThrow(/METAAPI_TOKEN/);
  });
});

describe("isRetryableFetchError", () => {
  it("retries plain network-level connectivity errors", () => {
    expect(isRetryableFetchError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
    expect(isRetryableFetchError(new Error("getaddrinfo ENOTFOUND mt-market-data-client-api-v1.london.agiliumtrade.ai"))).toBe(true);
    expect(isRetryableFetchError(new Error("socket hang up"))).toBe(true);
  });

  it("retries MetaApi's own 'account not connected to broker yet' rejection -- a real, confirmed transient condition (2026-09-08), not a permanent one", () => {
    expect(
      isRetryableFetchError(
        new Error(
          "It seems like the account decd9958-81dc-428e-9f59-2299fbe29942 is not connected to broker yet or request URL you use does not match the account region."
        )
      )
    ).toBe(true);
  });

  it("does not retry a genuine application-level rejection", () => {
    expect(isRetryableFetchError(new Error("Invalid symbol EURUSDx"))).toBe(false);
    expect(isRetryableFetchError(new Error("Unauthorized"))).toBe(false);
  });
});
