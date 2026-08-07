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

  it("counts only filled trades for a given UTC day", () => {
    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-3", signalId: "signal-3" });
    positionStore.markFilled("signal-3", { filledEntry: 1.105, filledAt: Date.UTC(2024, 1, 1, 8, 0, 2) });
    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-4", signalId: "signal-4" });
    positionStore.markRejected("signal-4", "insufficient margin");

    const filledToday = positionStore.tradesOnDay("2024-02-01");
    expect(filledToday.map((t) => t.signalId)).toContain("signal-3");
    expect(filledToday.map((t) => t.signalId)).not.toContain("signal-4");
  });

  it("scopes tradesOnDay to the requested account only", () => {
    positionStore.recordAttempt({ ...ATTEMPT, id: "trade-demo-2", signalId: "signal-demo-2", account: "demo" });
    positionStore.markFilled(
      "signal-demo-2",
      { filledEntry: 1.105, filledAt: Date.UTC(2024, 1, 1, 9, 0, 0) },
      "demo"
    );

    const demoFilled = positionStore.tradesOnDay("2024-02-01", "demo");
    expect(demoFilled.map((t) => t.signalId)).toContain("signal-demo-2");
    expect(demoFilled.every((t) => t.account === "demo")).toBe(true);

    const liveFilled = positionStore.tradesOnDay("2024-02-01", "live");
    expect(liveFilled.some((t) => t.signalId === "signal-demo-2")).toBe(false);
  });
});
