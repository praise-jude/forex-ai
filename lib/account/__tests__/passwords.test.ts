import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../passwords";

describe("passwords", () => {
  it("verifies the correct password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("never stores the password in plain text -- the hash never contains the raw password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse battery staple");
  });

  it("produces a different hash each time (real salting), yet both still verify", async () => {
    const hashA = await hashPassword("same password");
    const hashB = await hashPassword("same password");
    expect(hashA).not.toBe(hashB);
    expect(await verifyPassword("same password", hashA)).toBe(true);
    expect(await verifyPassword("same password", hashB)).toBe(true);
  });
});
