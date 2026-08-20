import { vi } from "vitest";
import type { deviceStore as DeviceStoreInstance } from "../deviceStore";

export interface DeviceStoreModule {
  deviceStore: typeof DeviceStoreInstance;
}

const globalKey = Symbol.for("forex-ai.deviceStore");

/**
 * Loads a fresh deviceStore module instance with an empty in-memory store. Clears the
 * globalThis-keyed singleton between loads so each test gets its own state -- DB
 * persistence (see deviceStore.ts's hydrate()) is a best-effort backstop that no-ops
 * without DATABASE_URL (never set in tests), same as positionStore.ts/signalStore.ts/
 * tradeJournal.ts's own tests, which don't exercise their DB path either.
 */
export async function loadDeviceStoreModule(): Promise<DeviceStoreModule> {
  delete (globalThis as Record<symbol, unknown>)[globalKey];
  vi.resetModules();
  return import("../deviceStore");
}
