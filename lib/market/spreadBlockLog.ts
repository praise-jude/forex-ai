import { randomUUID } from "node:crypto";
import { getOptionalDb } from "../db/optionalClient";
import { spreadBlockLog } from "../db/tradingSchema";
import type { AccountKey, ConfidenceTier, Pair } from "./types";

/**
 * Durable evidence log for riskManager.ts's checkSpread gate -- see spreadBlockLog's own
 * schema doc comment (lib/db/tradingSchema.ts) for why this exists: maxSpreadFractionOfStop
 * was raised on engineering judgment alone (2026-09-12), since this specific gate can
 * never be backtested against real historical spread data. Every real block, going
 * forward, is what eventually turns that judgment call into an evidence-based one.
 *
 * Fire-and-forget, same posture as every other DB write in this codebase -- a failed
 * insert must never affect the real execution decision, which has already been made by
 * the time this is called. No-ops silently when DATABASE_URL isn't set.
 */
export function recordSpreadBlock(input: {
  account: AccountKey;
  pair: Pair;
  direction: "long" | "short";
  tier: ConfidenceTier;
  confidence: number;
  spread: number;
  stopDistance: number;
  maxSpreadFractionOfStop: number;
}): void {
  const db = getOptionalDb();
  if (!db) return;
  db.insert(spreadBlockLog)
    .values({ id: randomUUID(), createdAt: new Date(), ...input })
    .catch((error: unknown) => {
      console.error("[spreadBlockLog] failed to record a wide_spread block:", error);
    });
}
