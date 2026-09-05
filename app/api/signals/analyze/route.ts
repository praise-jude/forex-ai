import { PAIRS, type Pair, type Timeframe } from "@/lib/market/types";
import { startAnalysisJob } from "@/lib/market/pairAnalysisJob";

export const runtime = "nodejs";

// Same three timeframes the SMC engine actually generates signals on -- see
// /api/signals/evaluate/route.ts's own identical list and doc comment.
const SIGNAL_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];

function isPair(value: unknown): value is Pair {
  return typeof value === "string" && PAIRS.includes(value as Pair);
}

function isSignalTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && SIGNAL_TIMEFRAMES.includes(value as Timeframe);
}

/**
 * Starts a real, multi-stage "Check a Pair" analysis job (see pairAnalysisJob.ts) and
 * returns immediately with its id -- the client polls GET /api/signals/analyze/[jobId]
 * to watch it progress through real stages. Read-only end-to-end: never publishes,
 * journals, or executes anything (see pairAnalysisJob.ts's own doc comment on the Auto
 * Pilot boundary). The existing single-shot GET /api/signals/evaluate is unchanged and
 * still used anywhere it already is.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { pair?: unknown; timeframe?: unknown } | null;
  if (!isPair(body?.pair)) {
    return Response.json({ error: "invalid_pair", message: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (!isSignalTimeframe(body?.timeframe)) {
    return Response.json({ error: "invalid_timeframe", message: `timeframe must be one of ${SIGNAL_TIMEFRAMES.join(", ")}` }, { status: 400 });
  }

  const job = startAnalysisJob(body.pair, body.timeframe);
  return Response.json({ jobId: job.id });
}
