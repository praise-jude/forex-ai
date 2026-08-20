import { eq } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { pushDevices as pushDevicesTable } from "../db/tradingSchema";
import type { DevicePlatform, NotificationPrefs, PushDevice } from "./types";
import { DEFAULT_NOTIFICATION_PREFS } from "./types";

/** Best-effort upsert, fired without awaiting from register()/updatePrefs() below -- a DB
 * failure must never affect registration. The in-memory Map stays the real, synchronous
 * source of truth (see DeviceStore's own class doc); this is a durability backstop, not a
 * new read path. */
async function persistUpsert(record: PushDevice): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db
    .insert(pushDevicesTable)
    .values({
      deviceId: record.deviceId,
      pushToken: record.pushToken,
      platform: record.platform,
      appVersion: record.appVersion,
      notificationPrefs: record.notificationPrefs,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    })
    .onConflictDoUpdate({
      target: pushDevicesTable.deviceId,
      set: {
        pushToken: record.pushToken,
        platform: record.platform,
        appVersion: record.appVersion,
        notificationPrefs: record.notificationPrefs,
        updatedAt: new Date(record.updatedAt),
      },
    });
}

async function persistDelete(deviceId: string): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db.delete(pushDevicesTable).where(eq(pushDevicesTable.deviceId, deviceId));
}

async function persistDeleteByToken(pushToken: string): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db.delete(pushDevicesTable).where(eq(pushDevicesTable.pushToken, pushToken));
}

/**
 * Registered push devices -- who to notify, and with which categories/confidence floor.
 * Same "in-memory Map is the real source of truth, DB is a best-effort durability
 * backstop" pattern as positionStore.ts/signalStore.ts (see tradingSchema.ts's
 * pushDevices comment for why this replaced a plain JSON file on disk: that file lived on
 * the app's own ephemeral container filesystem, not the Postgres volume, so it silently
 * lost every registered phone on every redeploy).
 */
class DeviceStore {
  private devices = new Map<string, PushDevice>();

  /** Reloads registered devices from the DB into memory -- called once at boot (see
   * bootstrap.ts) so a restart doesn't unregister every phone. No-ops when DATABASE_URL
   * isn't set. */
  async hydrate(): Promise<void> {
    const db = getOptionalDb();
    if (!db) return;
    const rows = await db.select().from(pushDevicesTable);
    for (const row of rows) {
      if (this.devices.has(row.deviceId)) continue;
      this.devices.set(row.deviceId, {
        deviceId: row.deviceId,
        pushToken: row.pushToken,
        platform: row.platform as DevicePlatform,
        appVersion: row.appVersion ?? undefined,
        notificationPrefs: row.notificationPrefs,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
      });
    }
  }

  /** Upserts by deviceId -- registering an already-known device (e.g. app reopened,
   * token refreshed) updates it in place rather than creating a duplicate row. */
  register(input: { deviceId: string; pushToken: string; platform: DevicePlatform; appVersion?: string }): PushDevice {
    const now = Date.now();
    const existing = this.devices.get(input.deviceId);
    const record: PushDevice = {
      deviceId: input.deviceId,
      pushToken: input.pushToken,
      platform: input.platform,
      appVersion: input.appVersion,
      notificationPrefs: existing?.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.devices.set(input.deviceId, record);
    void persistUpsert(record).catch((error: unknown) => {
      console.error(`[deviceStore] failed to persist registration for ${record.deviceId}:`, error);
    });
    return record;
  }

  updatePrefs(deviceId: string, prefs: Partial<NotificationPrefs>): PushDevice | undefined {
    const existing = this.devices.get(deviceId);
    if (!existing) return undefined;
    existing.notificationPrefs = { ...existing.notificationPrefs, ...prefs };
    existing.updatedAt = Date.now();
    void persistUpsert(existing).catch((error: unknown) => {
      console.error(`[deviceStore] failed to persist prefs update for ${deviceId}:`, error);
    });
    return existing;
  }

  unregister(deviceId: string): void {
    if (this.devices.delete(deviceId)) {
      void persistDelete(deviceId).catch((error: unknown) => {
        console.error(`[deviceStore] failed to persist unregister for ${deviceId}:`, error);
      });
    }
  }

  /** Used by pushNotifier to drop a token Expo reports as no longer valid
   * (DeviceNotRegistered) -- an uninstalled app or a stale token left behind. */
  removeByToken(pushToken: string): void {
    for (const [deviceId, device] of this.devices) {
      if (device.pushToken === pushToken) this.devices.delete(deviceId);
    }
    void persistDeleteByToken(pushToken).catch((error: unknown) => {
      console.error(`[deviceStore] failed to persist token removal:`, error);
    });
  }

  all(): PushDevice[] {
    return Array.from(this.devices.values());
  }

  get(deviceId: string): PushDevice | undefined {
    return this.devices.get(deviceId);
  }
}

const globalKey = Symbol.for("forex-ai.deviceStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: DeviceStore };
const g = globalThis as GlobalWithStore;

export const deviceStore: DeviceStore = g[globalKey] ?? (g[globalKey] = new DeviceStore());
