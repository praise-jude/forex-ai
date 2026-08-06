import { signalStore } from "@/lib/market/signalStore";
import { attemptExecution } from "@/lib/market/executionEngine";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signal = signalStore.get(id);
  if (!signal) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }

  const result = await attemptExecution(signal);
  return Response.json(result);
}
