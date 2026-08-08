import type { DevicePlatform } from "@/lib/market/types";
import { deviceStore } from "@/lib/market/deviceStore";

export const runtime = "nodejs";

const PLATFORMS: DevicePlatform[] = ["ios", "android", "web"];

function isPlatform(value: unknown): value is DevicePlatform {
  return typeof value === "string" && PLATFORMS.includes(value as DevicePlatform);
}

/**
 * Registers (or re-registers) this device for push notifications. Called on app start
 * and whenever Expo hands the app a refreshed push token -- upserts by deviceId, so a
 * token refresh updates the existing row instead of leaving a stale duplicate behind.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { deviceId?: string; pushToken?: string; platform?: string; appVersion?: string }
    | null;

  if (!body?.deviceId || typeof body.deviceId !== "string") {
    return Response.json({ error: "deviceId is required" }, { status: 400 });
  }
  if (!body.pushToken || typeof body.pushToken !== "string") {
    return Response.json({ error: "pushToken is required" }, { status: 400 });
  }
  if (!isPlatform(body.platform)) {
    return Response.json({ error: `platform must be one of ${PLATFORMS.join(", ")}` }, { status: 400 });
  }

  const device = deviceStore.register({
    deviceId: body.deviceId,
    pushToken: body.pushToken,
    platform: body.platform,
    appVersion: body.appVersion,
  });

  return Response.json(device);
}
