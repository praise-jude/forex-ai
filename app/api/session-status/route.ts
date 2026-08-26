import { currentKillzoneStatus } from "@/lib/market/sessionAlerts";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(currentKillzoneStatus());
}
