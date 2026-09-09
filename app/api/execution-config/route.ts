import { loadExecutionConfig } from "@/lib/market/executionConfig";
import { isAccountConfigured } from "@/lib/market/metaApiConnection";
import { setEngineToggle, type ToggleableEngine } from "@/lib/market/engineToggles";
import type { AccountKey } from "@/lib/market/types";

export const runtime = "nodejs";

// Read-only exposure of the same env-var-backed config the web /settings page already
// shows via ExecutionConfigTable -- this route exists so mobile can show the exact same
// numbers (risk %, max daily loss, position management, etc.) without a second,
// hand-maintained copy of the env-reading logic.
export async function GET() {
  return Response.json({
    live: loadExecutionConfig("live"),
    demo: isAccountConfigured("demo") ? loadExecutionConfig("demo") : null,
  });
}

function isAccountKey(value: unknown): value is AccountKey {
  return value === "live" || value === "demo";
}

function isToggleableEngine(value: unknown): value is ToggleableEngine {
  return value === "range_engine" || value === "trend_continuation";
}

/** The real dashboard on/off switch for Range Engine / Trend Continuation (see
 * engineToggles.ts) -- a real operator action, not a config file edit. Persists
 * immediately (best-effort; the in-memory override is set synchronously either way) and
 * returns the resulting full config so the client can update its display from the
 * response alone, without a second GET round trip. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { account?: string; engine?: string; enabled?: boolean } | null;
  const { account, engine, enabled } = body ?? {};

  if (!isAccountKey(account) || !isToggleableEngine(engine) || typeof enabled !== "boolean") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  setEngineToggle(account, engine, enabled);

  return Response.json({
    live: loadExecutionConfig("live"),
    demo: isAccountConfigured("demo") ? loadExecutionConfig("demo") : null,
  });
}
