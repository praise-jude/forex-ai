import { getAnalysisJob } from "@/lib/market/pairAnalysisJob";

export const runtime = "nodejs";

/** Polled every ~200ms by the client while a "Check a Pair" analysis job is running --
 * see pairAnalysisJob.ts. Returns the job's current real stage/status/result as-is. */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getAnalysisJob(jobId);
  if (!job) return Response.json({ error: "not_found", message: "No analysis job with that id." }, { status: 404 });
  return Response.json(job);
}
