import { beforeEach, describe, expect, it } from "vitest";
import { signalStore } from "../signalStore";
import { buildSignal } from "./fixtures";

describe("signalStore", () => {
  beforeEach(() => {
    // No reset method exists (matches every other globalThis-singleton store in this
    // app) -- give each test a unique id/pair combination instead so they can't collide.
  });

  it("add() then get() returns the same signal", () => {
    const signal = buildSignal({ id: "signal-a" });
    signalStore.add(signal);
    expect(signalStore.get("signal-a")).toEqual(signal);
  });

  it("get() returns undefined for an unknown id", () => {
    expect(signalStore.get("does-not-exist")).toBeUndefined();
  });

  it("add() is idempotent by id -- a re-added signal doesn't appear twice in all()", () => {
    const signal = buildSignal({ id: "signal-b", pair: "GBP/USD" });
    signalStore.add(signal);
    signalStore.add(signal);
    signalStore.add({ ...signal, entry: 999 }); // even a modified re-delivery is a no-op

    const matches = signalStore.all().filter((s) => s.id === "signal-b");
    expect(matches).toHaveLength(1);
    expect(matches[0].entry).toBe(signal.entry); // first write wins, not the re-delivery
  });
});
