import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_CONFIRMATION_PHRASE,
  autoExecutionAccount,
  enableLiveMode,
  getEngineMode,
  manualExecutionAccount,
  resetEngineModeForTests,
  setEngineMode,
} from "../engineMode";

describe("engineMode", () => {
  afterEach(() => {
    resetEngineModeForTests();
  });

  it("defaults to analysis", () => {
    expect(getEngineMode()).toBe("analysis");
  });

  it("setEngineMode switches between analysis and demo with no gating", () => {
    setEngineMode("demo");
    expect(getEngineMode()).toBe("demo");
    setEngineMode("analysis");
    expect(getEngineMode()).toBe("analysis");
  });

  it("enableLiveMode rejects a wrong phrase and leaves mode unchanged", () => {
    const result = enableLiveMode("not the phrase");
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(getEngineMode()).toBe("analysis");
  });

  it("enableLiveMode accepts the exact phrase, including surrounding whitespace", () => {
    expect(enableLiveMode(`  ${LIVE_CONFIRMATION_PHRASE}  `)).toEqual({ ok: true });
    expect(getEngineMode()).toBe("live");
  });

  it("resetEngineModeForTests always returns to analysis", () => {
    setEngineMode("demo");
    resetEngineModeForTests();
    expect(getEngineMode()).toBe("analysis");
  });
});

describe("manualExecutionAccount", () => {
  it("targets live in analysis and live modes, demo only in demo mode", () => {
    expect(manualExecutionAccount("analysis")).toBe("live");
    expect(manualExecutionAccount("live")).toBe("live");
    expect(manualExecutionAccount("demo")).toBe("demo");
  });
});

describe("autoExecutionAccount", () => {
  it("is null in analysis (no auto-execution), otherwise matches the mode", () => {
    expect(autoExecutionAccount("analysis")).toBeNull();
    expect(autoExecutionAccount("demo")).toBe("demo");
    expect(autoExecutionAccount("live")).toBe("live");
  });
});
