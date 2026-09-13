import { randomUUID } from "node:crypto";
import { getOptionalDb } from "../db/optionalClient";
import { fillPriceCheckLog } from "../db/tradingSchema";
import type { AccountKey, Pair } from "./types";

/**
 * Durable evidence log for metaApiConnection.ts's waitForOpenedPosition -- see
 * fillPriceCheckLog's own schema doc comment (lib/db/tradingSchema.ts) for why this
 * exists: a console-log-only diagnostic already caught one real fill, but the evidence
 * was gone before anyone could read it -- a deploy in between tore down the container,
 * and Railway only keeps the current one's logs. This survives that.
 *
 * Fire-and-forget, same posture as every other DB write in this codebase -- a failed
 * insert must never affect order placement, which has already completed by the time
 * this is called. No-ops silently when DATABASE_URL isn't set.
 */
export function recordFillPriceCheck(input: {
  account: AccountKey;
  pair: Pair;
  direction: "long" | "short";
  requestedEntry: number;
  brokerPositionId: string | undefined;
  found: boolean;
  attempts: number;
  openPrice: number | null;
  presentPositionIds: number[] | null;
}): void {
  const db = getOptionalDb();
  if (!db) return;
  const { brokerPositionId, ...rest } = input;
  db.insert(fillPriceCheckLog)
    .values({ id: randomUUID(), createdAt: new Date(), brokerPositionId: brokerPositionId ?? null, ...rest })
    .catch((error: unknown) => {
      console.error("[fillPriceCheckLog] failed to record a fill-price check:", error);
    });
}
