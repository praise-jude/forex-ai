import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Stage 1 of the paid API platform (customer accounts) -- deliberately separate from
// every trading store elsewhere in lib/market/, which stay file/in-memory as they
// already are. This is the app's first real relational data: customer accounts, not
// runtime trading state.
//
// IDs are app-generated crypto.randomUUID() (Node core), not a DB-side default --
// sidesteps needing to confirm the pgcrypto extension is enabled on this Postgres
// instance, and keeps ID generation visible in application code rather than DB magic,
// matching this codebase's general preference for explicit over implicit (e.g.
// TRADING_KILL_SWITCH must be set explicitly; nothing auto-enables).
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  // Normalized (trimmed + lowercased) in application code before every read/write --
  // avoids needing the citext extension for case-insensitive uniqueness.
  email: text("email").notNull().unique(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  // Null for Google-only accounts (no password ever set).
  passwordHash: text("password_hash"),
  // Google's own stable `sub` claim -- per Google's documented recommendation, never
  // trust the email claim alone as proof of identity.
  googleSub: text("google_sub").unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // App-set on every UPDATE (no DB trigger) -- see lib/db/users.ts.
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

// DB-backed opaque sessions, not stateless JWTs -- see lib/account/sessions.ts's own
// doc comment for why. The primary key IS the session token's hash; the raw token only
// ever exists in the httpOnly cookie, never persisted.
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Fixed TTL at creation -- no sliding-window renewal in Stage 1.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Snapshotted at creation time -- protects a future email-change flow from a stale
  // link verifying a since-changed address.
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Set on use -- prevents replay of a still-unexpired reset link after it's been
  // consumed once.
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
