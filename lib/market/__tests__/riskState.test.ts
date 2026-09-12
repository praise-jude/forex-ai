import { describe, expect, it } from "vitest";
import { requiresAcknowledgement, riskState } from "../riskState";

const DAY_1 = Date.UTC(2024, 1, 1, 10, 0, 0);
const DAY_1_LATER = Date.UTC(2024, 1, 1, 23, 0, 0);
const DAY_2 = Date.UTC(2024, 1, 2, 0, 30, 0);

describe("riskState", () => {
  it("anchors start-of-day equity on first use and doesn't drift within the same day", () => {
    const first = riskState.current(DAY_1, 10000);
    expect(first).toMatchObject({
      startOfDayEquity: 10000,
      tradesOpenedToday: 0,
      haltedForToday: false,
      consecutiveLosses: 0,
      cooldownUntil: null,
    });

    const later = riskState.current(DAY_1_LATER, 9800);
    expect(later.startOfDayEquity).toBe(10000); // unchanged even though "current equity" passed in differs
  });

  it("tracks trades opened and halted status within the day", () => {
    riskState.recordTradeOpened(DAY_1_LATER, 9800);
    riskState.recordTradeOpened(DAY_1_LATER, 9700);
    riskState.setHaltedForToday(DAY_1_LATER, 9700);

    const state = riskState.current(DAY_1_LATER, 9700);
    expect(state.tradesOpenedToday).toBe(2);
    expect(state.haltedForToday).toBe(true);
  });

  it("resets everything when the UTC day rolls over", () => {
    const rolledOver = riskState.current(DAY_2, 9700);
    expect(rolledOver).toEqual({
      dayKey: "2024-02-02",
      startOfDayEquity: 9700,
      tradesOpenedToday: 0,
      haltedForToday: false,
      consecutiveLosses: 0,
      cooldownUntil: null,
      pausedAt: null,
      acknowledgedAt: null,
    });
  });

  it("keeps demo and live daily state fully independent", () => {
    const day = Date.UTC(2024, 2, 1, 10, 0, 0);
    riskState.current(day, 50000, "live");
    riskState.current(day, 5000, "demo");

    riskState.recordTradeOpened(day, 50000, "live");
    riskState.recordTradeOpened(day, 5000, "demo");
    riskState.recordTradeOpened(day, 5000, "demo");
    riskState.setHaltedForToday(day, 5000, "demo");

    const live = riskState.current(day, 50000, "live");
    const demo = riskState.current(day, 5000, "demo");
    expect(live.tradesOpenedToday).toBe(1);
    expect(live.haltedForToday).toBe(false); // a halted demo day never halts live
    expect(demo.tradesOpenedToday).toBe(2);
    expect(demo.haltedForToday).toBe(true);
  });
});

describe("riskState.recordTradeClosed", () => {
  const DAY = Date.UTC(2024, 3, 1, 10, 0, 0);

  it("builds a losing streak and trips a cooldown once it reaches the threshold", () => {
    riskState.recordTradeClosed(DAY, 10000, -50, 3, 30, "live");
    riskState.recordTradeClosed(DAY, 9950, -50, 3, 30, "live");
    expect(riskState.current(DAY, 9950, "live").consecutiveLosses).toBe(2);
    expect(riskState.current(DAY, 9950, "live").cooldownUntil).toBeNull();

    riskState.recordTradeClosed(DAY, 9900, -50, 3, 30, "live");
    const state = riskState.current(DAY, 9900, "live");
    expect(state.consecutiveLosses).toBe(0); // reset once the cooldown trips
    expect(state.cooldownUntil).toBe(DAY + 30 * 60_000);
  });

  it("a win resets the streak without touching an unrelated active cooldown", () => {
    riskState.recordTradeClosed(DAY, 10000, -50, 3, 30, "demo");
    riskState.recordTradeClosed(DAY, 9950, -50, 3, 30, "demo");
    riskState.recordTradeClosed(DAY, 9900, 200, 3, 30, "demo"); // a win before hitting the threshold
    expect(riskState.current(DAY, 9900, "demo").consecutiveLosses).toBe(0);
    expect(riskState.current(DAY, 9900, "demo").cooldownUntil).toBeNull();
  });

  it("a breakeven deal (profit exactly 0) leaves the streak unchanged", () => {
    const day = Date.UTC(2024, 3, 2, 10, 0, 0);
    riskState.recordTradeClosed(day, 10000, -50, 5, 30, "live");
    riskState.recordTradeClosed(day, 9950, 0, 5, 30, "live");
    expect(riskState.current(day, 9950, "live").consecutiveLosses).toBe(1);
  });
});

describe("requiresAcknowledgement / riskState.acknowledge", () => {
  it("does not require acknowledgement before anything has ever paused", () => {
    const day = Date.UTC(2024, 4, 1, 10, 0, 0);
    const state = riskState.current(day, 10000, "live");
    expect(requiresAcknowledgement(state)).toBe(false);
  });

  it("requires acknowledgement once a halt trips, even after acknowledging would be expected to clear it automatically", () => {
    const day = Date.UTC(2024, 4, 2, 10, 0, 0);
    riskState.setHaltedForToday(day, 10000, "live");
    expect(requiresAcknowledgement(riskState.current(day, 10000, "live"))).toBe(true);
  });

  it("clears once acknowledged, and re-requires it after a fresh trip", () => {
    const account = "demo";
    const tripTime = Date.UTC(2024, 4, 3, 10, 0, 0);
    riskState.setHaltedForToday(tripTime, 5000, account);
    expect(requiresAcknowledgement(riskState.current(tripTime, 5000, account))).toBe(true);

    const ackTime = tripTime + 60_000;
    riskState.acknowledge(ackTime, 5000, account);
    expect(requiresAcknowledgement(riskState.current(ackTime, 5000, account))).toBe(false);

    const secondTripTime = ackTime + 60_000;
    riskState.setHaltedForToday(secondTripTime, 5000, account);
    expect(requiresAcknowledgement(riskState.current(secondTripTime, 5000, account))).toBe(true);
  });

  it("requires acknowledgement once a cooldown trips via recordTradeClosed", () => {
    const account = "live";
    const day = Date.UTC(2024, 4, 4, 10, 0, 0);
    riskState.recordTradeClosed(day, 10000, -50, 2, 30, account);
    riskState.recordTradeClosed(day, 9950, -50, 2, 30, account);
    expect(requiresAcknowledgement(riskState.current(day, 9950, account))).toBe(true);
  });
});

describe("riskState.forceResetHaltedForToday", () => {
  it("clears an active halt the same day, without waiting for it to lift on its own", () => {
    const day = Date.UTC(2024, 4, 5, 10, 0, 0);
    riskState.setHaltedForToday(day, 9700, "live");
    expect(riskState.current(day, 9700, "live").haltedForToday).toBe(true);

    riskState.forceResetHaltedForToday(day, 9700, "live");
    const state = riskState.current(day, 9700, "live");
    expect(state.haltedForToday).toBe(false);
    expect(requiresAcknowledgement(state)).toBe(false);
  });

  it("leaves tradesOpenedToday, consecutiveLosses, and startOfDayEquity untouched -- it un-blocks trading, it doesn't widen the day's loss budget", () => {
    const day = Date.UTC(2024, 4, 6, 10, 0, 0);
    riskState.current(day, 10000, "live"); // anchors startOfDayEquity
    riskState.recordTradeOpened(day, 9700, "live");
    riskState.setHaltedForToday(day, 9700, "live");

    riskState.forceResetHaltedForToday(day, 9700, "live");
    const state = riskState.current(day, 9700, "live");
    expect(state.startOfDayEquity).toBe(10000);
    expect(state.tradesOpenedToday).toBe(1);
  });
});

describe("riskState.reanchorStartOfDayEquity", () => {
  it("re-anchors startOfDayEquity to current equity and clears an active halt -- unlike forceResetHaltedForToday, which deliberately leaves the stale anchor in place", () => {
    // Mirrors the real, confirmed 2026-09-12 incident: a $218 account anchored at day
    // start, then a manual withdrawal drops real equity to $102 -- read as a 53% "daily
    // loss" and correctly-but-wrongly trips the halt. forceResetHaltedForToday alone
    // would clear the halt but leave the $218 anchor, so the very next check would
    // immediately re-trip against the same now-permanently-wrong drawdown%.
    const day = Date.UTC(2024, 4, 7, 10, 0, 0);
    riskState.current(day, 218.03, "live"); // anchors startOfDayEquity at 218.03
    riskState.setHaltedForToday(day, 102.44, "live");
    expect(riskState.current(day, 102.44, "live").haltedForToday).toBe(true);

    riskState.reanchorStartOfDayEquity(day, 102.44, "live");
    const state = riskState.current(day, 102.44, "live");
    expect(state.startOfDayEquity).toBe(102.44);
    expect(state.haltedForToday).toBe(false);
    expect(requiresAcknowledgement(state)).toBe(false);
  });

  it("also clears an active cooldown -- a deposit/withdrawal invalidates a consecutive-loss read the same way it does a daily-loss one", () => {
    const day = Date.UTC(2024, 4, 8, 10, 0, 0);
    riskState.recordTradeClosed(day, 9700, -100, 1, 30, "live"); // trips a cooldown with maxConsecutiveLosses=1
    expect(riskState.current(day, 9700, "live").cooldownUntil).not.toBeNull();

    riskState.reanchorStartOfDayEquity(day, 9700, "live");
    expect(riskState.current(day, 9700, "live").cooldownUntil).toBeNull();
  });

  it("leaves tradesOpenedToday and consecutiveLosses untouched -- only the equity-derived fields change", () => {
    const day = Date.UTC(2024, 4, 9, 10, 0, 0);
    riskState.current(day, 10000, "live");
    riskState.recordTradeOpened(day, 9700, "live");

    riskState.reanchorStartOfDayEquity(day, 5000, "live");
    expect(riskState.current(day, 5000, "live").tradesOpenedToday).toBe(1);
  });
});
