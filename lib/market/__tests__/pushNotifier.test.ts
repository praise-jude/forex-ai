import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushDevice } from "../types";
import { DEFAULT_NOTIFICATION_PREFS } from "../types";

const sendPushNotificationsAsync = vi.fn();
const chunkPushNotifications = vi.fn((messages: unknown[]) => [messages]);
const removeByToken = vi.fn();
const all = vi.fn<() => PushDevice[]>();

vi.mock("../deviceStore", () => ({
  deviceStore: { all, removeByToken },
}));

vi.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(token: unknown): boolean {
      return typeof token === "string" && token.startsWith("ExponentPushToken");
    }
    sendPushNotificationsAsync = sendPushNotificationsAsync;
    chunkPushNotifications = chunkPushNotifications;
  }
  return { Expo };
});

function device(overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    deviceId: "device-1",
    pushToken: "ExponentPushToken[abc]",
    platform: "ios",
    notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("pushNotifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "receipt-1" }]);
    chunkPushNotifications.mockImplementation((messages: unknown[]) => [messages]);
  });

  it("sends to a device whose prefs allow the category", async () => {
    all.mockReturnValue([device()]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "buy_signal", title: "t", body: "b", confidence: 90 });

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const [messages] = sendPushNotificationsAsync.mock.calls[0];
    expect(messages).toEqual([expect.objectContaining({ to: "ExponentPushToken[abc]", title: "t", body: "b" })]);
  });

  it("skips a device that disabled this category", async () => {
    all.mockReturnValue([device({ notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, buySignals: false } })]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "buy_signal", title: "t", body: "b", confidence: 90 });

    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("skips a signal below the device's minConfidence", async () => {
    all.mockReturnValue([device({ notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, minConfidence: 95 } })]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "buy_signal", title: "t", body: "b", confidence: 90 });

    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("does not gate non-signal categories by minConfidence", async () => {
    all.mockReturnValue([device({ notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, minConfidence: 95 } })]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "risk_alert", title: "t", body: "b" });

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it("skips devices with a malformed push token without calling Expo at all", async () => {
    all.mockReturnValue([device({ pushToken: "not-a-real-token" })]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "risk_alert", title: "t", body: "b" });

    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("prunes a device whose token Expo reports as unregistered", async () => {
    all.mockReturnValue([device()]);
    sendPushNotificationsAsync.mockResolvedValue([
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    ]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "risk_alert", title: "t", body: "b" });

    expect(removeByToken).toHaveBeenCalledWith("ExponentPushToken[abc]");
  });

  it("is a no-op with zero eligible devices", async () => {
    all.mockReturnValue([]);
    const { sendNotification } = await import("../pushNotifier");

    await sendNotification({ category: "risk_alert", title: "t", body: "b" });

    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("never throws when the Expo API call rejects", async () => {
    all.mockReturnValue([device()]);
    sendPushNotificationsAsync.mockRejectedValue(new Error("network down"));
    const { sendNotification } = await import("../pushNotifier");

    await expect(sendNotification({ category: "risk_alert", title: "t", body: "b" })).resolves.toBeUndefined();
  });
});
