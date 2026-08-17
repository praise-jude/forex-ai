import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_CONFIRMATION_PHRASE,
  autoExecutionAccount,
  checkEngineModeAfterRestart,
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

describe("checkEngineModeAfterRestart", () => {
  afterEach(() => {
    resetEngineModeForTests();
  });

  // Deliberately doesn't assert on whether a notification was sent -- that depends on
  // whatever was last persisted to the DB by earlier runs/tests, which this suite
  // doesn't control (see engineMode.ts's own "best-effort, DB may be unconfigured"
  // posture). What every environment can assert regardless: this never touches the
  // in-memory mode itself (only setEngineMode/enableLiveMode may), and never throws.
  it("never mutates the in-memory engine mode", async () => {
    setEngineMode("demo");
    await checkEngineModeAfterRestart();
    expect(getEngineMode()).toBe("demo");
  });

  it("resolves without throwing regardless of DB configuration", async () => {
    await expect(checkEngineModeAfterRestart()).resolves.toBeUndefined();
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
