import { describe, expect, it, vi } from "vitest";

// The module pulls in the MetaApi SDK and the DB client transitively -- stub those so
// this stays a fast, pure unit test of the decision helpers (same approach as
// connectionWatchdog.test.ts).
vi.mock("../metaApiConnection", () => ({
  getConnectionStatus: vi.fn(() => ({ status: "disconnected", lastUpdateAt: null })),
  getAccountInformation: vi.fn(() => undefined),
}));
vi.mock("../engineMode", () => ({
  resumeLiveModeAfterRestart: vi.fn(),
  setEngineMode: vi.fn(),
}));
vi.mock("../pushNotifier", () => ({ sendNotification: vi.fn(() => Promise.resolve()) }));
vi.mock("../riskState", () => ({
  riskState: { current: vi.fn() },
  requiresAcknowledgement: vi.fn(() => false),
}));
vi.mock("../../db/optionalClient", () => ({ getOptionalDb: () => null }));

const NOW = 1_760_000_000_000;
const MIN = 60_000;

describe("liveModeRecovery pure helpers", () => {
  it("recordBoot appends the current boot and caps history at 10", async () => {
    const { recordBoot } = await import("../liveModeRecovery");
    const old = Array.from({ length: 12 }, (_, i) => NOW - i * MIN);
    const next = recordBoot(old, NOW);
    expect(next).toHaveLength(10);
    expect(next[next.length - 1]).toBe(NOW);
  });

  it("recordBoot drops timestamps older than twice the loop window and any in the future", async () => {
    const { recordBoot } = await import("../liveModeRecovery");
    const next = recordBoot([NOW - 90 * MIN, NOW + 5 * MIN, NOW - 5 * MIN], NOW);
    expect(next).toEqual([NOW - 5 * MIN, NOW]);
  });

  it("isRestartLoop is true only at 3+ boots inside the 30-minute window", async () => {
    const { isRestartLoop } = await import("../liveModeRecovery");
    expect(isRestartLoop([NOW - 20 * MIN, NOW], NOW)).toBe(false);
    expect(isRestartLoop([NOW - 20 * MIN, NOW - 10 * MIN, NOW], NOW)).toBe(true);
    // The oldest falls outside the window -> only 2 count -> not a loop.
    expect(isRestartLoop([NOW - 40 * MIN, NOW - 10 * MIN, NOW], NOW)).toBe(false);
  });

  describe("liveRecoveryReadiness", () => {
    it("waits for a stable connection when MT5 isn't live", async () => {
      const { liveRecoveryReadiness } = await import("../liveModeRecovery");
      const r = liveRecoveryReadiness({
        connectionStatus: "reconnecting",
        connectionHealthySinceMs: null,
        equity: 5000,
        requiresRiskAck: false,
        nowMs: NOW,
      });
      expect(r).toEqual({ ready: false, waitingOn: "a stable MT5 connection" });
    });

    it("waits out the stability window even once the connection is live", async () => {
      const { liveRecoveryReadiness } = await import("../liveModeRecovery");
      const r = liveRecoveryReadiness({
        connectionStatus: "live",
        connectionHealthySinceMs: NOW - 2 * MIN,
        equity: 5000,
        requiresRiskAck: false,
        nowMs: NOW,
      });
      expect(r.ready).toBe(false);
      expect(r.waitingOn).toMatch(/stable for a few minutes/);
    });

    it("blocks on zero / unsynced equity", async () => {
      const { liveRecoveryReadiness } = await import("../liveModeRecovery");
      const r = liveRecoveryReadiness({
        connectionStatus: "live",
        connectionHealthySinceMs: NOW - 5 * MIN,
        equity: 0,
        requiresRiskAck: false,
        nowMs: NOW,
      });
      expect(r).toEqual({ ready: false, waitingOn: "the account balance to finish syncing" });
    });

    it("blocks while a risk halt/cooldown is awaiting review", async () => {
      const { liveRecoveryReadiness } = await import("../liveModeRecovery");
      const r = liveRecoveryReadiness({
        connectionStatus: "live",
        connectionHealthySinceMs: NOW - 5 * MIN,
        equity: 5000,
        requiresRiskAck: true,
        nowMs: NOW,
      });
      expect(r).toEqual({ ready: false, waitingOn: "the risk halt / cooldown to be reviewed" });
    });

    it("is ready only when connection is stable, equity is positive, and no risk gate is pending", async () => {
      const { liveRecoveryReadiness } = await import("../liveModeRecovery");
      const r = liveRecoveryReadiness({
        connectionStatus: "live",
        connectionHealthySinceMs: NOW - 4 * MIN,
        equity: 5000,
        requiresRiskAck: false,
        nowMs: NOW,
      });
      expect(r).toEqual({ ready: true, waitingOn: null });
    });
  });
});
