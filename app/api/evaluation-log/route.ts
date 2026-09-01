import { PAIRS, type Pair } from "@/lib/market/types";
import { getEvaluationHistory } from "@/lib/market/evaluationLog";

export const runtime = "nodejs";

function isPair(value: string | null): value is Pair {
  return value !== null && PAIRS.includes(value as Pair);
}

function isSource(value: string | null): value is "smc" | "mean_reversion" {
  return value === "smc" || value === "mean_reversion";
}

/** Backs the evaluation-history view -- every evaluation an engine has run recently
 * (both fired signals and no_trade holds), each with its own stage-by-stage pipeline
 * breakdown. See evaluationLog.ts's own doc comment for why this exists as a separate,
 * DB-backed table rather than reading predictionStore (which only ever keeps the latest
 * evaluation per pair/timeframe/source). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const pairParam = url.searchParams.get("pair");
  const sourceParam = url.searchParams.get("source");
  const limitParam = url.searchParams.get("limit");

  const entries = await getEvaluationHistory({
    pair: isPair(pairParam) ? pairParam : undefined,
    source: isSource(sourceParam) ? sourceParam : undefined,
    limit: limitParam ? Number(limitParam) : undefined,
  });

  return Response.json({ entries });
}
