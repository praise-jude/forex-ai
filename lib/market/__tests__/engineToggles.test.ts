import { afterEach, describe, expect, it } from "vitest";
import { getEngineToggleOverride, resetEngineTogglesForTests, setEngineToggle } from "../engineToggles";

describe("engineToggles", () => {
  afterEach(() => {
    resetEngineTogglesForTests();
  });

  it("is null (no override) before anything has ever been explicitly set", () => {
    expect(getEngineToggleOverride("live", "range_engine")).toBeNull();
    expect(getEngineToggleOverride("live", "trend_continuation")).toBeNull();
  });

  it("reflects an explicit override immediately after setting it", () => {
    setEngineToggle("live", "trend_continuation", true);
    expect(getEngineToggleOverride("live", "trend_continuation")).toBe(true);
  });

  it("keeps live and demo overrides independent of each other", () => {
    setEngineToggle("live", "range_engine", true);
    expect(getEngineToggleOverride("live", "range_engine")).toBe(true);
    expect(getEngineToggleOverride("demo", "range_engine")).toBeNull();
  });

  it("keeps range_engine and trend_continuation overrides independent of each other", () => {
    setEngineToggle("live", "range_engine", true);
    expect(getEngineToggleOverride("live", "trend_continuation")).toBeNull();
  });

  it("an explicit false override is distinguishable from no override at all", () => {
    setEngineToggle("live", "trend_continuation", false);
    expect(getEngineToggleOverride("live", "trend_continuation")).toBe(false);
  });
});
