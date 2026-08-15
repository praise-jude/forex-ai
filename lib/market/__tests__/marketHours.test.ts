import { describe, expect, it } from "vitest";
import { isMarketClosed } from "../marketHours";

// All instants below are computed against America/New_York, which was EST (UTC-5, no
// DST) throughout January 2024 -- keeps the UTC arithmetic in this file simple and
// unambiguous. Jan 1 2024 was a Monday, so Jan 3/5/6/7 are Wed/Fri/Sat/Sun respectively.
describe("isMarketClosed", () => {
  it("is closed all day Saturday", () => {
    const sat = Date.UTC(2024, 0, 6, 12, 0);
    expect(isMarketClosed("EUR/USD", sat)).toBe(true);
  });

  it("is closed Sunday before the 5pm NY reopen", () => {
    const sundayMorning = Date.UTC(2024, 0, 7, 10, 0); // 5am NY
    expect(isMarketClosed("EUR/USD", sundayMorning)).toBe(true);
  });

  it("is open Sunday at/after the 5pm NY reopen", () => {
    const sundayEvening = Date.UTC(2024, 0, 7, 22, 0); // exactly 5pm NY
    expect(isMarketClosed("EUR/USD", sundayEvening)).toBe(false);
  });

  it("is open Friday before the 5pm NY close", () => {
    const fridayAfternoon = Date.UTC(2024, 0, 5, 20, 0); // 3pm NY
    expect(isMarketClosed("EUR/USD", fridayAfternoon)).toBe(false);
  });

  it("is closed Friday at/after the 5pm NY close", () => {
    const fridayEvening = Date.UTC(2024, 0, 5, 22, 0); // exactly 5pm NY
    expect(isMarketClosed("EUR/USD", fridayEvening)).toBe(true);
  });

  it("is open on an ordinary weekday", () => {
    const wednesday = Date.UTC(2024, 0, 3, 12, 0);
    expect(isMarketClosed("EUR/USD", wednesday)).toBe(false);
    expect(isMarketClosed("XAU/USD", wednesday)).toBe(false);
    expect(isMarketClosed("USOIL", wednesday)).toBe(false);
  });

  it("never treats crypto as closed", () => {
    const sat = Date.UTC(2024, 0, 6, 12, 0);
    expect(isMarketClosed("BTC/USD", sat)).toBe(false);
  });
});
