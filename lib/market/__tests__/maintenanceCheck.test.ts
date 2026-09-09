import { describe, expect, it } from "vitest";
import { sectionHealth, type CheckItem } from "../maintenanceCheck";

function item(status: CheckItem["status"]): CheckItem {
  return { label: "x", status, detail: "" };
}

describe("sectionHealth", () => {
  it("is 100 for an empty section -- nothing to check is not the same as something failing", () => {
    expect(sectionHealth([])).toBe(100);
  });

  it("is 100 when every item passes", () => {
    expect(sectionHealth([item("pass"), item("pass"), item("pass")])).toBe(100);
  });

  it("is 0 when every item fails", () => {
    expect(sectionHealth([item("fail"), item("fail")])).toBe(0);
  });

  it("counts not_configured as full credit -- a deliberately-off optional feature isn't a technical failure", () => {
    expect(sectionHealth([item("pass"), item("not_configured")])).toBe(100);
  });

  it("counts warning as half credit, distinct from both pass and fail", () => {
    expect(sectionHealth([item("pass"), item("warning")])).toBe(75);
    expect(sectionHealth([item("warning"), item("fail")])).toBe(25);
  });

  it("a real mixed section lands proportionally, not rounded to an extreme", () => {
    expect(sectionHealth([item("pass"), item("pass"), item("pass"), item("fail")])).toBe(75);
  });
});
