import { publishSignal } from "@/lib/market/signalPublisher";
import { attemptExecution } from "@/lib/market/executionEngine";
import { DEFAULT_MAX_ALERT_AGE_MS, parseTradingViewAlert } from "@/lib/market/tradingViewWebhook";

export const runtime = "nodejs";

function maxAlertAgeMs(): number {
  const raw = process.env.TRADINGVIEW_MAX_ALERT_AGE_SECONDS;
  if (!raw) return DEFAULT_MAX_ALERT_AGE_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_MAX_ALERT_AGE_MS;
}

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

  const parsed = parseTradingViewAlert(body, { maxAgeMs: maxAlertAgeMs() });
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  publishSignal(parsed.signal);

  const result = await attemptExecution(parsed.signal);
  return Response.json(result);
}
