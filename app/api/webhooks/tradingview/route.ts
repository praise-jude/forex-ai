import { signalStore } from "@/lib/market/signalStore";
import { eventBus } from "@/lib/market/eventBus";
import { attemptExecution } from "@/lib/market/executionEngine";
import { parseTradingViewAlert } from "@/lib/market/tradingViewWebhook";

export const runtime = "nodejs";

// TradingView's alert webhooks POST a plain configured message body with no custom
// headers, so the shared secret has to travel inside the JSON body itself -- standard
// practice for TradingView webhooks specifically. Checked here (an env/auth concern),
// not inside the pure parser (a payload-shape concern).
export async function POST(request: Request) {
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "webhook not configured" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || (body as Record<string, unknown>).secret !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = parseTradingViewAlert(body);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  signalStore.add(parsed.signal);
  eventBus.publish({ type: "signal", signal: parsed.signal });

  const result = await attemptExecution(parsed.signal);
  return Response.json(result);
}
