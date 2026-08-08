import fs from "node:fs";
import type { DevicePlatform, NotificationPrefs, PushDevice } from "./types";
import { DEFAULT_NOTIFICATION_PREFS } from "./types";

// Unlike every other store in this app (signals, positions, risk state), registered push
// devices MUST survive a restart -- losing them silently unsubscribes every phone from
// notifications until the app is reopened. There's no database in this app (see README's
// "Not built yet"), so this is a plain JSON file on the persistent volume, following the
// same "runtime state file on disk" pattern the kill switch already uses.
const STORE_FILE = process.env.DEVICE_STORE_FILE ?? ".device-tokens.json";

interface OnDisk {
  devices: PushDevice[];
}

function readFromDisk(): Map<string, PushDevice> {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as OnDisk;
    return new Map(parsed.devices.map((d) => [d.deviceId, d]));
  } catch {
    // Missing file (first boot) or corrupt content -- start empty rather than crash the
    // whole server over a runtime-state file, same philosophy as the kill switch's
    // fs.existsSync try/catch.
    return new Map();
  }
}

class DeviceStore {
  private devices: Map<string, PushDevice> | null = null;

  private load(): Map<string, PushDevice> {
    if (!this.devices) this.devices = readFromDisk();
    return this.devices;
  }

  private persist(): void {
    const onDisk: OnDisk = { devices: Array.from(this.load().values()) };
    fs.writeFileSync(STORE_FILE, JSON.stringify(onDisk, null, 2));
  }

  /** Upserts by deviceId -- registering an already-known device (e.g. app reopened,
   * token refreshed) updates it in place rather than creating a duplicate row. */
  register(input: { deviceId: string; pushToken: string; platform: DevicePlatform; appVersion?: string }): PushDevice {
    const devices = this.load();
    const now = Date.now();
    const existing = devices.get(input.deviceId);
    const record: PushDevice = {
      deviceId: input.deviceId,
      pushToken: input.pushToken,
      platform: input.platform,
      appVersion: input.appVersion,
      notificationPrefs: existing?.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    devices.set(input.deviceId, record);
    this.persist();
    return record;
  }

  updatePrefs(deviceId: string, prefs: Partial<NotificationPrefs>): PushDevice | undefined {
    const devices = this.load();
    const existing = devices.get(deviceId);
    if (!existing) return undefined;
    existing.notificationPrefs = { ...existing.notificationPrefs, ...prefs };
    existing.updatedAt = Date.now();
    this.persist();
    return existing;
  }

  unregister(deviceId: string): void {
    const devices = this.load();
    if (devices.delete(deviceId)) this.persist();
  }

  /** Used by pushNotifier to drop a token Expo reports as no longer valid
   * (DeviceNotRegistered) -- an uninstalled app or a stale token left behind. */
  removeByToken(pushToken: string): void {
    const devices = this.load();
    for (const [deviceId, device] of devices) {
      if (device.pushToken === pushToken) devices.delete(deviceId);
    }
    this.persist();
  }

  all(): PushDevice[] {
    return Array.from(this.load().values());
  }

  get(deviceId: string): PushDevice | undefined {
    return this.load().get(deviceId);
  }
}

const globalKey = Symbol.for("forex-ai.deviceStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: DeviceStore };
const g = globalThis as GlobalWithStore;

export const deviceStore: DeviceStore = g[globalKey] ?? (g[globalKey] = new DeviceStore());
