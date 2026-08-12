import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";

export type User = typeof users.$inferSelect;

/** Trim + lowercase before every read/write -- the sole normalization this app relies
 * on for case-insensitive email uniqueness (see schema.ts's own comment on why this
 * avoids needing the citext extension). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return user;
}

export async function findUserByGoogleSub(googleSub: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.googleSub, googleSub)).limit(1);
  return user;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export interface CreateUserInput {
  email: string;
  passwordHash?: string;
  googleSub?: string;
  name?: string;
  /** Google-verified accounts start pre-verified (Google already confirmed the
   * address); email/password accounts start unverified and go through the
   * verify-email flow. Never fabricated true for a path that hasn't actually proven
   * the address. */
  emailVerified?: boolean;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const now = new Date();
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      googleSub: input.googleSub,
      name: input.name,
      emailVerifiedAt: input.emailVerified ? now : undefined,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return user;
}

export async function markEmailVerified(userId: string): Promise<void> {
  await db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

/** Links a Google account to an existing email/password user the first time they sign
 * in with Google using the same address -- never overwrites an existing googleSub. */
export async function linkGoogleAccount(userId: string, googleSub: string): Promise<void> {
  await db.update(users).set({ googleSub, updatedAt: new Date() }).where(eq(users.id, userId));
}
