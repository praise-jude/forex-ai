import { backtestRunner } from "@/lib/market/backtest/backtestRunner";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = backtestRunner.getById(id);
  if (!job) return Response.json({ error: "not_found", message: "No backtest job with that id." }, { status: 404 });
  return Response.json(job);
}

// Only cancels if `id` matches the currently running job -- a past, already-completed
// run in history can't be "cancelled" after the fact, there's nothing in flight to stop.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cancelled = backtestRunner.cancel(id);
  if (!cancelled) {
    return Response.json({ error: "not_running", message: "No running backtest job with that id." }, { status: 409 });
  }
  return Response.json({ ok: true });
}
