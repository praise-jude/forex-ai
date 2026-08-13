import { deviceStore } from "@/lib/market/deviceStore";
import type { NotificationPrefs } from "@/lib/market/types";

export const runtime = "nodejs";

const PREF_KEYS: (keyof NotificationPrefs)[] = [
  "buySignals",
  "sellSignals",
  "tradeExecution",
  "tpSl",
  "riskAlerts",
  "connectionAlerts",
  "weeklyDigest",
  "minConfidence",
];

function sanitizePrefs(input: unknown): Partial<NotificationPrefs> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const out: Partial<NotificationPrefs> = {};
  for (const key of PREF_KEYS) {
    const value = record[key];
    if (key === "minConfidence") {
      if (typeof value === "number" && Number.isFinite(value)) out.minConfidence = Math.min(100, Math.max(0, value));
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

export async function GET(_request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  const device = deviceStore.get(deviceId);
  if (!device) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(device);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  const body = (await request.json().catch(() => null)) as { notificationPrefs?: unknown } | null;
  const prefs = sanitizePrefs(body?.notificationPrefs);

  const updated = deviceStore.updatePrefs(deviceId, prefs);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(updated);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  deviceStore.unregister(deviceId);
  return Response.json({ ok: true });
}
