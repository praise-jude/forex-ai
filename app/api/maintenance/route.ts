import { runMaintenanceScan } from "@/lib/market/maintenanceCheck";

export const runtime = "nodejs";

// Read-only -- runMaintenanceScan itself never mutates anything (see its own doc
// comment). Always scans "live", the only real account this deployment has configured.
export async function GET() {
  const report = await runMaintenanceScan("live");
  return Response.json(report);
}
