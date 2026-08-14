import { doublePrecision, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
