import { describe, expect, it } from "vitest";
import { generateToken, hashToken, isExpired } from "../tokens";

describe("generateToken", () => {
  it("produces a real random raw value and its matching hash", () => {
    const { raw, hash } = generateToken();
    expect(raw).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex-encoded
    expect(hash).toBe(hashToken(raw));
  });

  it("never produces the same raw token twice", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.raw).not.toBe(b.raw);
  });

  it("the hash never equals the raw value -- the raw token is never what gets persisted", () => {
    const { raw, hash } = generateToken();
    expect(hash).not.toBe(raw);
  });
});

describe("hashToken", () => {
  it("is deterministic -- the same raw value always hashes the same way, so lookup-by-hash works", () => {
    const { raw } = generateToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
  });
});

describe("isExpired", () => {
  it("is false before the expiry instant, true at and after it", () => {
    const expiresAt = new Date(1_000_000);
    expect(isExpired(expiresAt, 999_999)).toBe(false);
    expect(isExpired(expiresAt, 1_000_000)).toBe(true);
    expect(isExpired(expiresAt, 1_000_001)).toBe(true);
  });
});
