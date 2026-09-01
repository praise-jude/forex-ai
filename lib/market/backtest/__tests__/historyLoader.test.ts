import { describe, expect, it } from "vitest";
import { resolveBacktestCredentials } from "../historyLoader";

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
