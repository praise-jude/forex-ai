import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOptionalDb = vi.fn();
const sendNotification = vi.fn<() => Promise<void>>();

vi.mock("../../db/optionalClient", () => ({
  getOptionalDb: (...args: unknown[]) => getOptionalDb(...args),
}));

vi.mock("../pushNotifier", () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...(args as [])),
}));

/** startEvaluationHealthMonitor/logEvaluation both key their state off globalThis
 * (Symbol.for), the same cross-module-instance-sharing pattern every other store in this
 * app uses -- vi.resetModules() alone does NOT clear that (globalThis outlives module
 * re-import), so each test clears the two symbols directly for real isolation. */
function clearGlobalHealthState() {
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for("forex-ai.evaluationLog.healthState")];
  delete g[Symbol.for("forex-ai.evaluationLog.pruneState")];
}

beforeEach(() => {
  vi.useFakeTimers();
  getOptionalDb.mockReset().mockReturnValue(null);
  sendNotification.mockReset().mockResolvedValue(undefined);
  clearGlobalHealthState();
  // A fresh module instance per test -- the module's top-level `const healthState = ...`
  // only ever evaluates once per import, capturing a fixed object reference, so clearing
  // the global symbol alone wouldn't be seen by an already-imported module.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  clearGlobalHealthState();
});

describe("evaluation log health monitor", () => {
  it("does not alert before the stall threshold, even with no evaluations yet", async () => {
    const { startEvaluationHealthMonitor } = await import("../evaluationLog");
    startEvaluationHealthMonitor();
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("alerts once the engine has been silent since boot for longer than the threshold", async () => {
    const { startEvaluationHealthMonitor } = await import("../evaluationLog");
    startEvaluationHealthMonitor();
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ category: "engine_health", title: expect.stringContaining("health warning") }));
  });

  it("does not re-alert every check once already alerting", async () => {
    const { startEvaluationHealthMonitor } = await import("../evaluationLog");
    startEvaluationHealthMonitor();
    vi.advanceTimersByTime(30 * 60 * 1000);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("a fresh evaluation before the threshold prevents the alert entirely", async () => {
    const { startEvaluationHealthMonitor, logEvaluation } = await import("../evaluationLog");
    startEvaluationHealthMonitor();
    vi.advanceTimersByTime(15 * 60 * 1000);
    await logEvaluation("EUR/USD", "15m", "smc", { status: "no_trade", reason: { code: "outside_killzone" } }, Date.now());
    vi.advanceTimersByTime(15 * 60 * 1000); // total 30min since boot, but only 15 since the fresh evaluation
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("clears an active alert and sends a recovery notification once evaluations resume", async () => {
    const { startEvaluationHealthMonitor, logEvaluation } = await import("../evaluationLog");
    startEvaluationHealthMonitor();
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await logEvaluation("EUR/USD", "15m", "smc", { status: "no_trade", reason: { code: "outside_killzone" } }, Date.now());
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenLastCalledWith(expect.objectContaining({ category: "engine_health", title: expect.stringContaining("resumed") }));

    // A later stall re-alerts -- the recovery didn't leave alertActive stuck true.
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(sendNotification).toHaveBeenCalledTimes(3);
  });
});
