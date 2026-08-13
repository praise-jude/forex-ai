import { signalStore } from "@/lib/market/signalStore";
import { tradeJournal } from "@/lib/market/tradeJournal";

export const runtime = "nodejs";

// Purely a recording step -- rejecting a proposal never touches execution/risk logic at
// all, it's the explicit-decline half of the signal funnel (see SignalOutcome's own doc
// comment in tradeJournal.ts). Unlike the execute route, no confirmation phrase or
// expiration check applies here: declining a trade is always safe regardless of timing.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signal = signalStore.get(id);
  if (!signal) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }

  tradeJournal.recordSignalOutcome({ signalId: signal.id, pair: signal.pair, outcome: "rejected", reason: null, timestamp: Date.now() });
  return Response.json({ ok: true });
}
