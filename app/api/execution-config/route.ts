import { loadExecutionConfig } from "@/lib/market/executionConfig";
import { isAccountConfigured } from "@/lib/market/metaApiConnection";

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
