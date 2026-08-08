import { describe, expect, it } from "vitest";
import { isAuthorized } from "../basicAuth";

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

describe("isAuthorized", () => {
  it("accepts a matching password regardless of username", () => {
    expect(isAuthorized(basicHeader("trader", "secret123"), "secret123")).toBe(true);
    expect(isAuthorized(basicHeader("anyone", "secret123"), "secret123")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(isAuthorized(basicHeader("trader", "wrong"), "secret123")).toBe(false);
  });

  it("rejects a missing, non-Basic, or malformed header instead of throwing", () => {
    expect(isAuthorized(null, "secret123")).toBe(false);
    expect(isAuthorized("Bearer sometoken", "secret123")).toBe(false);
    expect(isAuthorized("Basic not-valid-base64!!", "secret123")).toBe(false);
  });

  it("handles a password that itself contains a colon", () => {
    expect(isAuthorized(basicHeader("trader", "sec:ret"), "sec:ret")).toBe(true);
  });
});
