import { describe, expect, it } from "vitest";
import { consume, mark } from "../invalidationMarker";

describe("invalidationMarker", () => {
  it("reports false for a position that was never marked", () => {
    expect(consume("never-marked")).toBe(false);
  });

  it("reports true for a freshly marked position within the TTL", () => {
    mark("pos-1");
    expect(consume("pos-1", Date.now() + 60_000)).toBe(true); // 1 minute later, within the 2-minute TTL
  });

  it("consumes the mark -- a second check for the same position reports false", () => {
    mark("pos-2");
    expect(consume("pos-2")).toBe(true);
    expect(consume("pos-2")).toBe(false);
  });

  it("reports false once the mark has aged past the TTL", () => {
    mark("pos-3");
    expect(consume("pos-3", Date.now() + 3 * 60 * 1000)).toBe(false); // 3 minutes later, past the 2-minute TTL
  });
});
