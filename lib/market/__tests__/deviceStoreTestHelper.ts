import { vi } from "vitest";
import type { deviceStore as DeviceStoreInstance } from "../deviceStore";

export interface DeviceStoreModule {
  deviceStore: typeof DeviceStoreInstance;
}

const globalKey = Symbol.for("forex-ai.deviceStore");

/**
 * Loads a fresh deviceStore module instance pointed at `storeFile`. Clears the
 * globalThis-keyed singleton (see deviceStore.ts's own comment on why that pattern
 * exists) between loads -- otherwise a second "reload" in the same test process would
 * just hand back the first load's in-memory instance instead of genuinely re-reading
 * from disk, defeating the point of testing restart persistence.
 */
export async function loadDeviceStoreModule(storeFile: string): Promise<DeviceStoreModule> {
  process.env.DEVICE_STORE_FILE = storeFile;
  delete (globalThis as Record<symbol, unknown>)[globalKey];
  vi.resetModules();
  return import("../deviceStore");
}
