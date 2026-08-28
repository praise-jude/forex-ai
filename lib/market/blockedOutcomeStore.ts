// A signal that gets blocked before ever reaching positionStore (a risk-check gate --
// wide spread, correlated exposure, daily loss, etc.) never creates an ExecutedTrade
// record: positionStore.recordAttempt() is only ever called once sizing succeeds and
// the broker call is about to fire, by design (see positionStore.ts's own doc comment
// on why recordAttempt must run synchronously right before the first await). That's
// correct for the audit ledger's own purpose, but it left a real, confirmed gap: a
// signal executed WITHOUT a client-side click in the same browser tab (the DEMO
// test-trade route auto-fires server-side; a real signal auto-executed by
// autoExecutionListener.ts is the same shape) that then gets blocked has nothing for
// Dashboard.tsx's statusFromTrade to seed from on the next page load -- the card just
// sits showing the generic idle "BUY NOW" state forever, with no sign an attempt ever
// happened. This is the durable, small, purpose-built record that closes that gap:
// keyed by signal id, exposed through /api/signals, seeded into cardStatuses exactly
// like a real ExecutedTrade already is (see Dashboard.tsx's seededStatuses).
export interface BlockedOutcome {
  code: string;
  reason: string;
  at: number;
}

// A "skipped_sizing" ExecuteResponse carries no `code` field (only "blocked" does) --
// this sentinel lets executionClient.ts's statusFromBlockedOutcome reconstruct the
// right status ("Skipped: ..." vs "Blocked: ...") from the single `code` this store
// keeps, without a second field just for that distinction.
export const SKIPPED_SIZING_CODE = "skipped_sizing";

// Same "bound an in-memory ledger, prune the oldest" posture as positionStore.ts's own
// MAX_RECORDS -- generous relative to realistic attempt volume, only ever prunes
// ancient history.
const MAX_RECORDS = 200;

const byId = new Map<string, BlockedOutcome>();

export function recordBlockedOutcome(signalId: string, code: string, reason: string): void {
  byId.set(signalId, { code, reason, at: Date.now() });
  if (byId.size > MAX_RECORDS) {
    const oldest = byId.keys().next().value;
    if (oldest !== undefined) byId.delete(oldest);
  }
}

export function allBlockedOutcomes(): Record<string, BlockedOutcome> {
  return Object.fromEntries(byId);
}
