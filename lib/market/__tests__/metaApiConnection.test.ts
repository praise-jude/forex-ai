import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAccountConfigured } from "../metaApiConnection";

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
