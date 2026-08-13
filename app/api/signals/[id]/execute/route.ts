import { signalStore } from "@/lib/market/signalStore";
import { attemptExecution } from "@/lib/market/executionEngine";
import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getConfirmationMode, isProposalExpired } from "@/lib/market/confirmationMode";
import { buildConfirmPhrase, normalize } from "@/lib/voice/grammar";
import { tradeJournal } from "@/lib/market/tradeJournal";

export const runtime = "nodejs";

interface ExecuteRequestBody {
  confirmationPhrase?: string;
  /** One-off risk% for this specific trade only (the dashboard's "Edit Risk" control) --
   * falls back to the account's configured riskPerTradePct when omitted. Never persists
   * beyond this one call. */
  riskPctOverride?: number;
}

/**
 * The actual trust boundary for manual execution -- every caller (dashboard button,
 * voice hard-confirm, JUDE chat's execute_trade tool) ends up here, and until this gate
 * existed, this route executed unconditionally the moment it was called: no
 * confirmation-phrase check, no expiration check, nothing stopping a bare POST from
 * firing a real order. Moving the checks into the route itself (not just each caller's
 * own client-side gate) means none of those callers -- or a raw API call bypassing all
 * of them -- can skip the approval step. See confirmationMode.ts's own doc comment for
 * why the phrase itself isn't treated as a secret (Basic Auth, via proxy.ts, is the
 * actual access boundary here -- the phrase exists to prevent *accidental* execution by
 * an already-authorized caller, the same reasoning as engineMode.ts's LIVE phrase).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signal = signalStore.get(id);
  if (!signal) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }

  const confirmationMode = getConfirmationMode();

  if (confirmationMode.manualMode === "signal_only") {
    tradeJournal.recordSignalOutcome({
      signalId: signal.id,
      pair: signal.pair,
      outcome: "blocked",
      reason: "signal_only_mode",
      timestamp: Date.now(),
    });
    return Response.json(
      { status: "blocked", code: "signal_only_mode", reason: "Manual execution is disabled in Signal Only mode." },
      { status: 403 }
    );
  }

  if (isProposalExpired(signal.createdAt, Date.now(), confirmationMode)) {
    tradeJournal.recordSignalOutcome({ signalId: signal.id, pair: signal.pair, outcome: "expired", reason: null, timestamp: Date.now() });
    return Response.json({ status: "expired" }, { status: 410 });
  }

  const body = (await request.json().catch(() => null)) as ExecuteRequestBody | null;
  const requiredPhrase = buildConfirmPhrase(signal);
  if (!body?.confirmationPhrase || normalize(body.confirmationPhrase) !== normalize(requiredPhrase)) {
    return Response.json({ status: "confirmation_required", requiredPhrase }, { status: 400 });
  }

  // Reaching this point IS the human's approval -- recorded before attemptExecution
  // even runs, so it reflects "a human said yes", independent of whether the broker
  // then actually fills it (see SignalOutcome's own doc comment).
  tradeJournal.recordSignalOutcome({ signalId: signal.id, pair: signal.pair, outcome: "approved", reason: null, timestamp: Date.now() });

  const riskPctOverride =
    typeof body.riskPctOverride === "number" && Number.isFinite(body.riskPctOverride) && body.riskPctOverride > 0
      ? body.riskPctOverride
      : undefined;

  // Mode-aware: a click in DEMO engine mode fires against the demo account, never live
  // — so testing in DEMO mode can't accidentally place a real order via a manual click.
  // In ANALYSIS or LIVE mode this resolves to "live", unchanged from before DEMO existed.
  const result = await attemptExecution(signal, manualExecutionAccount(getEngineMode()), riskPctOverride);
  return Response.json(result);
}
