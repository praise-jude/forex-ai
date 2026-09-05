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
function normalizeTradingViewError(error: unknown): { error: string; message: string } {
  const message = typeof error === "string" && error.trim().length > 0 ? error : "Invalid TradingView alert payload.";
  return {
    error: "invalid_alert",
    message,
  };
}

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
    return Response.json(normalizeTradingViewError(parsed.error), { status: 400 });
  }

  publishSignal(parsed.signal);

  // Wrapped for the same reason as the manual-execute route (see commit 168b7fa): a hard
  // failure inside execution must return an honest 500 JSON body instead of dropping the
  // connection on TradingView, which would otherwise see a generic delivery failure with
  // no indication of what actually went wrong.
  try {
    const result = await attemptExecution(parsed.signal);
    return Response.json(result);
  } catch (error) {
    console.error(`[tradingview] signal ${parsed.signal.id} (${parsed.signal.pair}) execution threw:`, error);
    return Response.json(
      {
        status: "blocked",
        code: "execution_error",
        reason: error instanceof Error ? error.message : "execution failed unexpectedly",
      },
      { status: 500 }
    );
  }
}
