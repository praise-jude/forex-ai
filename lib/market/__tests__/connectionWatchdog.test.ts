import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getConnectionStatus = vi.fn<() => { status: string; lastUpdateAt: number | null }>();
const forceReconnect = vi.fn<() => Promise<void>>();
const isAccountConfigured = vi.fn(() => false);
const sendNotification = vi.fn<() => Promise<void>>();

vi.mock("../metaApiConnection", () => ({
  getConnectionStatus: (...args: unknown[]) => getConnectionStatus(...(args as [])),
  forceReconnect: (...args: unknown[]) => forceReconnect(...(args as [])),
  isAccountConfigured: (...args: unknown[]) => isAccountConfigured(...(args as [])),
}));

vi.mock("../pushNotifier", () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...(args as [])),
}));

describe("connectionWatchdog", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    getConnectionStatus.mockReset();
    forceReconnect.mockReset();
    sendNotification.mockReset().mockResolvedValue(undefined);
    // Never actually kill the test process -- just record that the escalation reached
    // for the exit, same as every other "assert the dangerous call was requested"
    // pattern in this codebase (e.g. execute_trade's confirm-phrase gates).
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("does nothing while the connection is live", async () => {
    const { checkOnce, resetConnectionWatchdogForTests } = await import("../connectionWatchdog");
    resetConnectionWatchdogForTests();
    getConnectionStatus.mockReturnValue({ status: "live", lastUpdateAt: Date.now() });

    await checkOnce("live");

    expect(forceReconnect).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not escalate before the stuck threshold is reached", async () => {
    const { checkOnce, resetConnectionWatchdogForTests } = await import("../connectionWatchdog");
    resetConnectionWatchdogForTests();
    getConnectionStatus.mockReturnValue({ status: "disconnected", lastUpdateAt: null });

    // First tick just starts the unhealthy timer -- no action yet.
    await checkOnce("live");
    // Second tick, immediately after -- still nowhere near the 3-minute threshold.
    await checkOnce("live");

    expect(forceReconnect).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("attempts a soft forceReconnect once the connection has been stuck long enough", async () => {
    vi.useFakeTimers();
    const { checkOnce, resetConnectionWatchdogForTests } = await import("../connectionWatchdog");
    resetConnectionWatchdogForTests();
    getConnectionStatus.mockReturnValue({ status: "disconnected", lastUpdateAt: null });
    forceReconnect.mockResolvedValue(undefined);

    await checkOnce("live"); // starts the unhealthy timer
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live"); // past the threshold -- should attempt a soft reconnect

    expect(forceReconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("restarts the process after exhausting soft reconnect attempts without ever recovering", async () => {
    vi.useFakeTimers();
    const { checkOnce, resetConnectionWatchdogForTests } = await import("../connectionWatchdog");
    resetConnectionWatchdogForTests();
    getConnectionStatus.mockReturnValue({ status: "disconnected", lastUpdateAt: null });
    forceReconnect.mockRejectedValue(new Error("still stuck"));

    // Escalation 1: fails. Each escalation clears the unhealthy-since timer, so an extra
    // tick is needed afterward to re-arm it before advancing to the next escalation.
    await checkOnce("live");
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live");
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    // Escalation 2: fails again -- still under MAX_SOFT_ATTEMPTS, no restart yet.
    await checkOnce("live"); // re-arms the timer
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live");
    expect(forceReconnect).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();

    // Escalation 3: soft attempts exhausted -- restarts instead of trying forceReconnect again.
    await checkOnce("live"); // re-arms the timer
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live");
    expect(forceReconnect).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ category: "connection_alert" }));
    vi.useRealTimers();
  });

  it("resets the escalation count once a genuinely live tick is observed", async () => {
    vi.useFakeTimers();
    const { checkOnce, resetConnectionWatchdogForTests } = await import("../connectionWatchdog");
    resetConnectionWatchdogForTests();
    forceReconnect.mockRejectedValue(new Error("still stuck"));

    getConnectionStatus.mockReturnValue({ status: "disconnected", lastUpdateAt: null });
    await checkOnce("live");
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live"); // escalation 1, fails
    expect(forceReconnect).toHaveBeenCalledTimes(1);

    // A real recovery in between -- should wipe the failure streak.
    getConnectionStatus.mockReturnValue({ status: "live", lastUpdateAt: Date.now() });
    await checkOnce("live");

    // Goes unhealthy again later -- this is a fresh episode, not attempt 2 of the old one.
    getConnectionStatus.mockReturnValue({ status: "disconnected", lastUpdateAt: null });
    await checkOnce("live");
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live"); // escalation 1 of the new episode
    await checkOnce("live"); // re-arms the timer
    vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    await checkOnce("live"); // escalation 2 -- this would be a restart if the old streak hadn't reset

    expect(exitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
