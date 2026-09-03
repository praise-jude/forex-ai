import type { ExecutedTrade } from "./types";
import { SKIPPED_SIZING_CODE } from "./blockedOutcomeStore";

// Mirrors ExecutionResult from executionEngine.ts (kept as a local, JSON-shaped type here
// rather than importing that server module client-side), plus two client-only outcomes
// for responses that never reach attemptExecution at all. Shared between SignalsPanel's
// manual Buy/Sell button and the voice assistant's hard-confirm path -- both call
// executeSignalRequest below, so both go through the exact same backend risk checks.
export type ExecuteResponse =
  | { status: "duplicate" }
  | { status: "blocked"; code: string; reason: string }
  | { status: "skipped_sizing"; reason: string }
  | { status: "filled"; trade: ExecutedTrade }
  | { status: "rejected"; trade: ExecutedTrade }
  | { status: "not_found" }
  | { status: "network_error" }
  // The request was aborted client-side after EXECUTE_TIMEOUT_MS with no response yet --
  // distinct from "network_error" (a fetch that failed outright) because here the request
  // may still be in flight/complete on the server (a slow broker round-trip, not a broken
  // connection), so the honest message is "check before retrying", not "try again".
  | { status: "timeout" }
  // The two new gate outcomes from the execute route (confirmationMode.ts) -- "expired"
  // means the proposal's approval window ran out before Approve was clicked;
  // "confirmation_required" shouldn't normally happen from the dashboard (it always
  // sends the right phrase automatically), only a real defensive-typing case.
  | { status: "expired" }
  | { status: "confirmation_required"; requiredPhrase: string };

export type CardStatus = { state: "idle" } | { state: "loading" } | { state: "done"; result: ExecuteResponse };

/** Seeds a card's status from a trade already on record (e.g. loaded on initial page
 * fetch) -- "pending" shouldn't outlive a single attemptExecution call, so there's
 * nothing to seed for it. */
export function statusFromTrade(trade: ExecutedTrade): CardStatus | null {
  if (trade.status === "filled") return { state: "done", result: { status: "filled", trade } };
  if (trade.status === "rejected") return { state: "done", result: { status: "rejected", trade } };
  return null;
}

/** Same seeding purpose as statusFromTrade, for a signal blocked before it ever reached
 * positionStore (see blockedOutcomeStore.ts's own doc comment on why that case needs a
 * separate source to seed from) -- an attempt that happened server-side with no client
 * click in this tab to have recorded it locally. */
export function statusFromBlockedOutcome(code: string, reason: string): CardStatus {
  if (code === SKIPPED_SIZING_CODE) return { state: "done", result: { status: "skipped_sizing", reason } };
  return { state: "done", result: { status: "blocked", code, reason } };
}

// How long to wait for the execute route before giving up client-side. Set well above
// a normal round-trip but still well under what feels like an actually-frozen page --
// confirmed real broker-side stalls (MetaApi reconnect + resync) taking 8+ seconds, so
// this needs headroom above that, not just above the happy path. Without this, a stuck
// request just spins "Placing order…" forever, which is what pushes an operator to hit
// browser Reload -- and reloading while the server is mid-broker-outage is what actually
// produces the blank "This page couldn't load" crash screen, not the slow request itself.
const EXECUTE_TIMEOUT_MS = 20_000;

export async function executeSignalRequest(
  signalId: string,
  confirmationPhrase: string,
  riskPctOverride?: number
): Promise<ExecuteResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/signals/${signalId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationPhrase, riskPctOverride }),
      signal: controller.signal,
    });
    return (await res.json()) as ExecuteResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { status: "timeout" };
    return { status: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
