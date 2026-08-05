import { describe, expect, it } from "vitest";
import { positionStore } from "../positionStore";

const ATTEMPT = {
  id: "trade-1",
  signalId: "signal-1",
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

  it("counts only filled trades for a given UTC day", () => {
    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-2", signalId: "signal-2" });
    positionStore.markRejected("signal-2", "insufficient margin");

    const filledToday = positionStore.tradesOnDay("2024-02-01");
    expect(filledToday).toHaveLength(1);
    expect(filledToday[0].signalId).toBe("signal-1");
  });
});
