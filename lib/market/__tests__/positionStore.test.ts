import { describe, expect, it } from "vitest";
import { positionStore } from "../positionStore";

const ATTEMPT = {
  id: "trade-1",
  signalId: "signal-1",
  account: "live" as const,
  pair: "EUR/USD" as const,
  direction: "long" as const,
  requestedLots: 0.5,
  requestedEntry: 1.105,
  stopLoss: 1.103,
  takeProfit: 1.109,
  riskPct: 1,
  attemptedAt: Date.UTC(2024, 1, 1, 8, 0, 0),
};

describe("positionStore", () => {
  it("reserves a signal id as pending before the outcome is known", () => {
    expect(positionStore.hasExecuted("signal-1")).toBe(false);
    const record = positionStore.recordAttempt(ATTEMPT);
    expect(record.status).toBe("pending");
    expect(positionStore.hasExecuted("signal-1")).toBe(true);
  });

  it("transitions to filled with broker details", () => {
    positionStore.markFilled("signal-1", {
      filledEntry: 1.1051,
      brokerPositionId: "pos-123",
      brokerOrderId: "ord-123",
      filledAt: Date.UTC(2024, 1, 1, 8, 0, 1),
    });

    const [record] = positionStore.all();
    expect(record).toMatchObject({ status: "filled", filledEntry: 1.1051, brokerPositionId: "pos-123" });
  });

  it("transitions to rejected with the broker's reason", () => {
    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-2", signalId: "signal-2" });
    positionStore.markRejected("signal-2", "insufficient margin");

    const record = positionStore.all().find((t) => t.signalId === "signal-2");
    expect(record).toMatchObject({ status: "rejected", rejectReason: "insufficient margin" });
  });

  it("tracks the same signal id independently per account", () => {
    expect(positionStore.hasExecuted("signal-shared")).toBe(false);
    expect(positionStore.hasExecuted("signal-shared", "demo")).toBe(false);

    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-demo", signalId: "signal-shared", account: "demo" });
    expect(positionStore.hasExecuted("signal-shared", "demo")).toBe(true);
    // The live account's record of the same signal id is untouched by the demo attempt.
    expect(positionStore.hasExecuted("signal-shared", "live")).toBe(false);

    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-live", signalId: "signal-shared", account: "live" });
    expect(positionStore.hasExecuted("signal-shared", "live")).toBe(true);
  });
});
