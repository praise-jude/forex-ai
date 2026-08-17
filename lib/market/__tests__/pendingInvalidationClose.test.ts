import { describe, expect, it } from "vitest";
import { clearPending, isPending, markPending } from "../pendingInvalidationClose";

describe("pendingInvalidationClose", () => {
  it("reports false for a position that was never marked", () => {
    expect(isPending("never-marked")).toBe(false);
  });

  it("reports true for a freshly marked position within the TTL", () => {
    markPending("pos-1");
    expect(isPending("pos-1", Date.now() + 10_000)).toBe(true); // 10s later, within the 30s TTL
  });

  it("does NOT consume the mark -- unlike invalidationMarker, this can be checked repeatedly while a close is in flight", () => {
    markPending("pos-2");
    expect(isPending("pos-2")).toBe(true);
    expect(isPending("pos-2")).toBe(true);
  });

  it("reports false once cleared, e.g. after the close attempt resolves", () => {
    markPending("pos-3");
    clearPending("pos-3");
    expect(isPending("pos-3")).toBe(false);
  });

  it("reports false once the mark has aged past the TTL, self-healing rather than leaking forever", () => {
    markPending("pos-4");
    expect(isPending("pos-4", Date.now() + 40_000)).toBe(false); // 40s later, past the 30s TTL
  });
});
