import { doublePrecision, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Durability/audit persistence for two of lib/market/*.ts's in-memory stores --
// signalStore.ts (every fired signal) and positionStore.ts (the execution ledger, "which
// signal caused which trade"). Both stores keep their own in-memory Map as the real,
// synchronous source of truth (see each store's own comments on why); these tables are a
// best-effort backstop so history survives a restart, written to via
// lib/db/optionalClient.ts rather than this app's other db client (lib/db/client.ts),
// which requires DATABASE_URL -- the trading engine must keep working with zero DB
// config, exactly as before this feature existed.
//
// IDs are the same app-generated crypto.randomUUID() values already used in memory
// (Signal.id / ExecutedTrade.id), not a DB-side default -- matches schema.ts's own
// convention and keeps a single id per record across both the in-memory and DB copies.
export const signals = pgTable("signals", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  pair: text("pair").notNull(),
  direction: text("direction").notNull(),
  entry: doublePrecision("entry").notNull(),
  stopLoss: doublePrecision("stop_loss").notNull(),
  takeProfit: doublePrecision("take_profit").notNull(),
  takeProfit2: doublePrecision("take_profit_2").notNull(),
  riskReward: doublePrecision("risk_reward").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  directionScore: doublePrecision("direction_score").notNull(),
  entryScore: doublePrecision("entry_score").notNull(),
  adx: doublePrecision("adx").notNull(),
  rsi: doublePrecision("rsi").notNull(),
  tier: text("tier").notNull(),
  // Signal["confluences"] is a fixed-vocabulary string array (see the Confluence union in
  // lib/market/types.ts) -- jsonb rather than a join table since it's never queried by
  // individual confluence, only ever read back whole alongside the rest of the signal.
  confluences: jsonb("confluences").notNull().$type<string[]>(),
  session: text("session").notNull(),
  timeframe: text("timeframe").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  zoneTop: doublePrecision("zone_top"),
  zoneBottom: doublePrecision("zone_bottom"),
  signerBDirection: text("signer_b_direction").notNull(),
  signerBConfidence: doublePrecision("signer_b_confidence").notNull(),
  signerBEmaTrend: text("signer_b_ema_trend").notNull(),
  rsiDivergence: text("rsi_divergence").notNull(),
  supertrendTrend: text("supertrend_trend").notNull(),
  usdStrengthStatus: text("usd_strength_status").notNull(),
  newsStatus: text("news_status").notNull(),
});

export const executedTrades = pgTable("executed_trades", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  account: text("account").notNull(),
  pair: text("pair").notNull(),
  timeframe: text("timeframe").notNull(),
  direction: text("direction").notNull(),
  requestedLots: doublePrecision("requested_lots").notNull(),
  requestedEntry: doublePrecision("requested_entry").notNull(),
  filledEntry: doublePrecision("filled_entry"),
  stopLoss: doublePrecision("stop_loss").notNull(),
  takeProfit: doublePrecision("take_profit").notNull(),
  takeProfit2: doublePrecision("take_profit_2").notNull(),
  status: text("status").notNull(),
  brokerPositionId: text("broker_position_id"),
  brokerOrderId: text("broker_order_id"),
  rejectReason: text("reject_reason"),
  riskPct: doublePrecision("risk_pct").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  filledAt: timestamp("filled_at", { withTimezone: true }),
});

// --- Trade journal persistence (lib/market/tradeJournal.ts) ---
// Replaces that module's old plain-JSON-file-on-disk store. Same pattern as
// signals/executedTrades above: the in-memory store stays the real, synchronous source
// of truth; these tables are a best-effort durability backstop.

// SignalContext, stored whole as jsonb rather than normalized into columns -- it has
// nested/array fields (setupQuality, confluences) that have already grown twice this
// session, and it's never queried by an individual field, only ever read back whole
// alongside the rest of the pending context/journal entry it's attached to.
export const journalPendingContexts = pgTable("journal_pending_contexts", {
  signalId: text("signal_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  context: jsonb("context").notNull().$type<Record<string, unknown>>(),
});

export const journalEntries = pgTable("journal_entries", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  account: text("account").notNull(),
  pair: text("pair").notNull(),
  timeframe: text("timeframe"),
  direction: text("direction").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  exitPrice: doublePrecision("exit_price").notNull(),
  profit: doublePrecision("profit").notNull(),
  riskDollars: doublePrecision("risk_dollars"),
  rMultiple: doublePrecision("r_multiple"),
  reason: text("reason").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  context: jsonb("context").$type<Record<string, unknown> | null>(),
});

// SignalOutcome has no app-generated id of its own (unlike Signal/ExecutedTrade) -- a
// DB-side serial is the simplest honest primary key rather than inventing one.
export const journalSignalOutcomes = pgTable("journal_signal_outcomes", {
  id: serial("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  pair: text("pair").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

// Tiny durability backstop for engineMode.ts's own in-memory mode -- NOT read back to
// auto-restore LIVE after a restart (that must always require a human to re-confirm,
// see engineMode.ts's own doc comment on why the in-memory default is unconditional).
// Read-back is only ever compared against the fresh post-boot default to detect "this
// restart silently dropped out of LIVE/DEMO", so a push notification can be sent -- see
// checkEngineModeAfterRestart in engineMode.ts. Always exactly one row (id "singleton").
export const engineModeState = pgTable("engine_mode_state", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
