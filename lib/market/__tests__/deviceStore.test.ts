import { beforeEach, describe, expect, it } from "vitest";
import type { DeviceStoreModule } from "./deviceStoreTestHelper";
import { loadDeviceStoreModule } from "./deviceStoreTestHelper";

describe("deviceStore", () => {
  let mod: DeviceStoreModule;

  beforeEach(async () => {
    mod = await loadDeviceStoreModule();
  });

  it("registers a new device with default notification prefs", () => {
    const device = mod.deviceStore.register({ deviceId: "device-1", pushToken: "ExponentPushToken[abc]", platform: "ios" });
    expect(device.notificationPrefs.buySignals).toBe(true);
    expect(device.notificationPrefs.minConfidence).toBe(80);
    expect(mod.deviceStore.get("device-1")).toMatchObject({ pushToken: "ExponentPushToken[abc]" });
  });

  it("upserts by deviceId, keeping prior prefs when a token refreshes", () => {
    mod.deviceStore.register({ deviceId: "device-1", pushToken: "old-token", platform: "ios" });
    mod.deviceStore.updatePrefs("device-1", { buySignals: false });

    const updated = mod.deviceStore.register({ deviceId: "device-1", pushToken: "new-token", platform: "ios" });
    expect(updated.pushToken).toBe("new-token");
    expect(updated.notificationPrefs.buySignals).toBe(false);
    expect(mod.deviceStore.all()).toHaveLength(1);
  });

  it("updates only the provided prefs, leaving the rest untouched", () => {
    mod.deviceStore.register({ deviceId: "device-1", pushToken: "tok", platform: "android" });
    const updated = mod.deviceStore.updatePrefs("device-1", { minConfidence: 90 });
    expect(updated?.notificationPrefs.minConfidence).toBe(90);
    expect(updated?.notificationPrefs.sellSignals).toBe(true);
  });

  it("returns undefined when updating prefs for an unknown device", () => {
    expect(mod.deviceStore.updatePrefs("missing", { buySignals: false })).toBeUndefined();
  });

  it("unregisters a device", () => {
    mod.deviceStore.register({ deviceId: "device-1", pushToken: "tok", platform: "android" });
    mod.deviceStore.unregister("device-1");
    expect(mod.deviceStore.get("device-1")).toBeUndefined();
  });

  it("removes a device by push token, e.g. after Expo reports it as unregistered", () => {
    mod.deviceStore.register({ deviceId: "device-1", pushToken: "stale-token", platform: "android" });
    mod.deviceStore.register({ deviceId: "device-2", pushToken: "fresh-token", platform: "ios" });

    mod.deviceStore.removeByToken("stale-token");

    expect(mod.deviceStore.get("device-1")).toBeUndefined();
    expect(mod.deviceStore.get("device-2")).toBeDefined();
  });

  it("starts empty before any device registers", () => {
    expect(mod.deviceStore.all()).toEqual([]);
  });
});
