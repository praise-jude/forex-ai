import { describe, expect, it } from "vitest";
import { computeLotSize } from "../positionSizing";
import { buildSignal, buildSpec } from "./fixtures";

describe("computeLotSize", () => {
  it("sizes to risk exactly the requested percentage of equity", () => {
    // 20 pip stop, $10 pip value/lot, 1% of $10,000 = $100 risk -> 0.5 lots.
    const signal = buildSignal({ pair: "EUR/USD", entry: 1.105, stopLoss: 1.103 });
    const result = computeLotSize(signal, 10000, 1, buildSpec());

    expect(result).toEqual({ lots: 0.5 });
  });

  it("rounds down to the broker's volume step rather than up", () => {
    // 20 pip stop, $10 pip value/lot, 1% of $10,100 = $101 risk -> raw lots 0.505,
    // which must round down to 0.50 on a 0.01 step, never up to 0.51.
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.103 });
    const result = computeLotSize(signal, 10100, 1, buildSpec());

    expect(result).toEqual({ lots: 0.5 });
  });

  it("skips rather than rounding up to the minimum when the risk-correct size is too small", () => {
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.103 });
    const result = computeLotSize(signal, 100, 1, buildSpec({ volumeMin: 0.01 }));

    expect(result).toEqual({ skipped: true, reason: expect.stringContaining("below the broker minimum") });
  });

  it("caps at the broker's maximum volume", () => {
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.1045 });
    const result = computeLotSize(signal, 1_000_000, 1, buildSpec({ volumeMax: 100 }));

    expect(result).toEqual({ lots: 100 });
  });

  it("skips when entry and stop loss are equal", () => {
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.105 });
    const result = computeLotSize(signal, 10000, 1, buildSpec());

    expect(result).toEqual({ skipped: true, reason: expect.stringContaining("zero pip distance") });
  });
});
