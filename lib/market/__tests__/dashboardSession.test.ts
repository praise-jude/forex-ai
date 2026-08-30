import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCookieValue, isValidSessionCookie } from "../dashboardSession";

describe("dashboardSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a cookie it just issued for the same password", () => {
    const cookie = createSessionCookieValue("secret123");
    expect(isValidSessionCookie(cookie, "secret123")).toBe(true);
  });

  it("rejects a cookie issued for a different password", () => {
    const cookie = createSessionCookieValue("secret123");
    expect(isValidSessionCookie(cookie, "wrong-password")).toBe(false);
  });

  it("rejects once the password has been rotated -- the whole point of deriving the signing key from it", () => {
    const cookie = createSessionCookieValue("old-password");
    expect(isValidSessionCookie(cookie, "new-password")).toBe(false);
  });

  it("rejects missing, malformed, or tampered values instead of throwing", () => {
    expect(isValidSessionCookie(undefined, "secret123")).toBe(false);
    expect(isValidSessionCookie("", "secret123")).toBe(false);
    expect(isValidSessionCookie("not-a-real-cookie", "secret123")).toBe(false);
    expect(isValidSessionCookie("123.not-hex-!!", "secret123")).toBe(false);

    const cookie = createSessionCookieValue("secret123");
    const [expiresAt] = cookie.split(".");
    // Same expiry, forged signature of a DIFFERENT length -- exercises the
    // length-mismatch branch that exists specifically to avoid timingSafeEqual throwing.
    expect(isValidSessionCookie(`${expiresAt}.ab`, "secret123")).toBe(false);
  });

  it("expires after its TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cookie = createSessionCookieValue("secret123");

    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + 179 * 24 * 60 * 60 * 1000);
    expect(isValidSessionCookie(cookie, "secret123")).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + 181 * 24 * 60 * 60 * 1000);
    expect(isValidSessionCookie(cookie, "secret123")).toBe(false);
  });
});
