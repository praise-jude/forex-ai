import { describe, expect, it } from "vitest";
import { calculateEma } from "../ema";

describe("calculateEma", () => {
  it("converges to a constant value on a flat series", () => {
    const values = new Array(10).fill(100);
    const result = calculateEma(values, 5);

    expect(result.slice(0, 4)).toEqual([NaN, NaN, NaN, NaN]);
    for (let i = 4; i < result.length; i++) expect(result[i]).toBeCloseTo(100, 10);
  });

  it("matches the standard EMA formula on a hand-computed series", () => {
    // period 3: seed = avg(1,2,3) = 2 at index 2; multiplier = 2/(3+1) = 0.5
    // index3: (4-2)*0.5+2 = 3; index4: (5-3)*0.5+3 = 4
    const result = calculateEma([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it("is all NaN when there isn't enough data for even one value", () => {
    expect(calculateEma([1, 2], 5)).toEqual([NaN, NaN]);
  });
});
