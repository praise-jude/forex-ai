import { getConnectionStatus } from "@/lib/market/metaApiConnection";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(getConnectionStatus());
}
