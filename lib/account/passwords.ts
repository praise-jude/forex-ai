import bcrypt from "bcryptjs";

// 12 is bcrypt's own commonly-recommended cost for an interactive login path (enough
// work to resist offline brute-forcing, cheap enough not to make sign-in noticeably
// slow) -- a documented default to tune later, not a claimed-optimal figure, same
// posture as every other weighted/tunable constant in this codebase.
const SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
