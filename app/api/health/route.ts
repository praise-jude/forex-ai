import { getConnectionStatus, isAccountConfigured } from "@/lib/market/metaApiConnection";
import { deviceStore } from "@/lib/market/deviceStore";

export const runtime = "nodejs";

/**
 * A quick "is everything wired up" snapshot for the mobile app's Settings screen (or any
 * status dashboard) -- reports presence/health of each optional integration, never a
 * secret value itself. Behind the same Basic Auth as every other /api/* route (see
 * proxy.ts); not added to PUBLIC_PATHS since operational detail (which accounts are
 * configured, how many devices are registered) still isn't meant for a public URL.
 */
export async function GET() {
  const live = getConnectionStatus("live");
  const demoConfigured = isAccountConfigured("demo");

  return Response.json({
    status: "ok",
    metaApi: {
      live: live.status,
      demo: demoConfigured ? getConnectionStatus("demo").status : "not_configured",
    },
    voice: Boolean(process.env.OPENAI_API_KEY),
    push: {
      registeredDevices: deviceStore.all().length,
    },
  });
}
