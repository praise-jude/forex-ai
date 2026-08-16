import { CORRELATION_THRESHOLD, correlationMatrixAge, listCorrelations } from "@/lib/market/rollingCorrelation";

export const runtime = "nodejs";

// Read-only exposure of the same matrix checkCorrelatedExposure (riskManager.ts)
// actually gates trades against -- lets an operator see "what's correlated right now"
// instead of trusting the risk gate blindly. All synchronous, in-memory reads (the
// matrix is recomputed periodically in the background, see rollingCorrelation.ts's
// startRollingCorrelation), so this is cheap to poll.
export async function GET() {
  return Response.json({
    entries: listCorrelations(),
    computedAtAgeMs: correlationMatrixAge(),
    threshold: CORRELATION_THRESHOLD,
  });
}
