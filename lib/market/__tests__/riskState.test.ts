import { describe, expect, it } from "vitest";
import { riskState } from "../riskState";

const DAY_1 = Date.UTC(2024, 1, 1, 10, 0, 0);
const DAY_1_LATER = Date.UTC(2024, 1, 1, 23, 0, 0);
const DAY_2 = Date.UTC(2024, 1, 2, 0, 30, 0);

describe("riskState", () => {
  it("anchors start-of-day equity on first use and doesn't drift within the same day", () => {
    const first = riskState.current(DAY_1, 10000);
    expect(first).toMatchObject({ startOfDayEquity: 10000, tradesOpenedToday: 0, haltedForToday: false });

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
    });
  });
});
