import type { ExecutedTrade } from "./types";

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
  | { status: "network_error" };

export type CardStatus = { state: "idle" } | { state: "loading" } | { state: "done"; result: ExecuteResponse };

/** Seeds a card's status from a trade already on record (e.g. loaded on initial page
 * fetch) -- "pending" shouldn't outlive a single attemptExecution call, so there's
 * nothing to seed for it. */
export function statusFromTrade(trade: ExecutedTrade): CardStatus | null {
  if (trade.status === "filled") return { state: "done", result: { status: "filled", trade } };
  if (trade.status === "rejected") return { state: "done", result: { status: "rejected", trade } };
  return null;
}

export async function executeSignalRequest(signalId: string): Promise<ExecuteResponse> {
  try {
    const res = await fetch(`/api/signals/${signalId}/execute`, { method: "POST" });
    return (await res.json()) as ExecuteResponse;
  } catch {
    return { status: "network_error" };
  }
}
