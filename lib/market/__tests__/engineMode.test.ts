import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOptionalDb = vi.fn();
const sendNotification = vi.fn<() => Promise<void>>();

vi.mock("../../db/optionalClient", () => ({
  getOptionalDb: (...args: unknown[]) => getOptionalDb(...args),
}));

vi.mock("../pushNotifier", () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...(args as [])),
}));

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

/** Fakes just enough of the drizzle chain checkEngineModeAfterRestart/persistMode use --
 * a select().from().where().limit() read returning `rows`, and an insert().values()
 * .onConflictDoUpdate() write that always resolves. */
function fakeDb(rows: { mode: string }[]) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }) }),
  };
}

beforeEach(() => {
  getOptionalDb.mockReset().mockReturnValue(null);
  sendNotification.mockReset().mockResolvedValue(undefined);
});

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

  it("no-ops (mode stays at its module-load default, no notification) when DATABASE_URL isn't configured", async () => {
    // getOptionalDb() already defaults to null via the top-level beforeEach.
    await checkEngineModeAfterRestart();
    expect(getEngineMode()).toBe("analysis");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("auto-resumes DEMO after a restart -- it risks no real money, unlike LIVE", async () => {
    getOptionalDb.mockReturnValue(fakeDb([{ mode: "demo" }]));
    await checkEngineModeAfterRestart();
    expect(getEngineMode()).toBe("demo");
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ category: "engine_mode_reset", title: expect.stringContaining("resumed") })
    );
  });

  it("never auto-resumes LIVE -- stays in ANALYSIS and notifies that it was reset", async () => {
    getOptionalDb.mockReturnValue(fakeDb([{ mode: "live" }]));
    await checkEngineModeAfterRestart();
    expect(getEngineMode()).toBe("analysis");
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ category: "engine_mode_reset", title: expect.stringContaining("reset to Analysis") })
    );
  });

  it("does nothing when no mode was ever persisted before (first-ever boot)", async () => {
    getOptionalDb.mockReturnValue(fakeDb([]));
    await checkEngineModeAfterRestart();
    expect(getEngineMode()).toBe("analysis");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("resolves without throwing even if the DB read rejects", async () => {
    // Read fails, but persistMode's own write (called unconditionally afterward) still
    // needs a working insert chain -- this isn't testing persistMode, just confirming a
    // broken read alone can't take the whole restart check down.
    getOptionalDb.mockReturnValue({
      ...fakeDb([]),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.reject(new Error("connection refused")),
          }),
        }),
      }),
    });
    await expect(checkEngineModeAfterRestart()).resolves.toBeUndefined();
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
