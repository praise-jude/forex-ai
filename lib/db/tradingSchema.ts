import { boolean, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { NotificationPrefs } from "../market/types";
import type { PipelineStage } from "../market/noTradeReason";

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

// Durability backstop for deviceStore.ts's registered push devices -- replaces that
// module's old plain-JSON-file-on-disk store (".device-tokens.json"), which lived on the
// app service's own container filesystem. Unlike the Postgres volume, that filesystem is
// NOT persistent across a Railway redeploy, so every deploy silently wiped every
// registered phone until it was reopened. Same pattern as executedTrades above: the
// in-memory Map stays the real, synchronous source of truth; this table is a best-effort
// durability backstop, hydrated back into memory at boot.
export const pushDevices = pgTable("push_devices", {
  deviceId: text("device_id").primaryKey(),
  pushToken: text("push_token").notNull(),
  platform: text("platform").notNull(),
  appVersion: text("app_version"),
  // NotificationPrefs (lib/market/types.ts) -- jsonb rather than one column per pref since
  // it's never queried by an individual field, only ever read back whole per device.
  notificationPrefs: jsonb("notification_prefs").notNull().$type<NotificationPrefs>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

// Durability backstop for riskState.ts's daily risk-guardian state (the daily-loss
// halt, revenge-trading cooldown, and their acknowledgement gate) -- like pushDevices
// above, this used to be pure in-memory with no persistence at all, so every redeploy
// silently reset it: a halt tripped by a real daily-loss breach would clear itself the
// moment the app restarted, with a fresh startOfDayEquity baseline computed from
// whatever the equity happened to be at that redeploy -- discovered when two live
// trades fired hours into a day that should have stayed halted. One row per account
// (live/demo), keyed by account rather than a single singleton row.
export const riskDailyState = pgTable("risk_daily_state", {
  account: text("account").primaryKey(),
  dayKey: text("day_key").notNull(),
  startOfDayEquity: doublePrecision("start_of_day_equity").notNull(),
  tradesOpenedToday: integer("trades_opened_today").notNull(),
  haltedForToday: boolean("halted_for_today").notNull(),
  consecutiveLosses: integer("consecutive_losses").notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
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

// Same "survive a Railway redeploy" reasoning as engineModeState above, but for
// autopilotLock.ts -- unlike engine mode (which always boots back to the safe ANALYSIS
// default on purpose, see engineMode.ts), a lock IS the safe state, so this one DOES get
// read back and restored on boot (see autopilotLock.ts's own hydrate). Always exactly one
// row (id "singleton").
export const autopilotLockState = pgTable("autopilot_lock_state", {
  id: text("id").primaryKey(),
  locked: boolean("locked").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

// Durable dedup ledger for metaApiConnection.ts's onDealAdded -- the MetaApi SDK can
// (and, per the "another cooldown" reports on 2026-08-27, does) redeliver the same
// historical closing deal as a fresh onDealAdded event across a reconnect resync or a
// process restart, and without this table every redelivery of the SAME real loss got
// re-counted by riskState.recordTradeClosed, tripping phantom "N consecutive losses"
// cooldowns for a loss that only ever happened once. Keyed by the broker's own deal
// ticket (dealId) -- already globally unique, so no account column is needed.
export const processedDeals = pgTable("processed_deals", {
  dealId: text("deal_id").primaryKey(),
  account: text("account").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull(),
});

// Persisted history of EVERY signal evaluation (both a real signal and a no_trade hold),
// not just the ones that fired -- see lib/market/evaluationLog.ts. predictionStore.ts
// only ever keeps the LATEST evaluation per pair/timeframe/source in memory, overwritten
// on the next candle close, so there was previously no way to look back at what a signal
// actually went through minutes or days after the fact. reasonDetail/pipelineStages are
// jsonb rather than normalized columns for the same reason journalPendingContexts.context
// is above -- read back whole, never queried by an individual nested field.
export const evaluationLog = pgTable("evaluation_log", {
  id: text("id").primaryKey(),
  pair: text("pair").notNull(),
  timeframe: text("timeframe").notNull(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  reasonCode: text("reason_code"),
  reasonDetail: jsonb("reason_detail").$type<Record<string, unknown> | null>(),
  signalTier: text("signal_tier"),
  signalConfidence: doublePrecision("signal_confidence"),
  pipelineStages: jsonb("pipeline_stages").notNull().$type<PipelineStage[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
