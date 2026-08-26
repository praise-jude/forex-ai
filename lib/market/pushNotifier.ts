import { Expo } from "expo-server-sdk";
import type { ExpoPushMessage } from "expo-server-sdk";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationCategory, type PushDevice } from "./types";
import { deviceStore } from "./deviceStore";

// Which NotificationPrefs boolean gates each category -- kept as one table so adding a
// category later is a one-line change here, not a scattered set of if/else checks.
const PREF_KEY_FOR_CATEGORY: Record<NotificationCategory, keyof PushDevice["notificationPrefs"]> = {
  buy_signal: "buySignals",
  sell_signal: "sellSignals",
  trade_opened: "tradeExecution",
  trade_closed: "tpSl",
  order_rejected: "tradeExecution",
  risk_alert: "riskAlerts",
  connection_alert: "connectionAlerts",
  weekly_digest: "weeklyDigest",
  daily_digest: "dailyDigest",
  engine_mode_reset: "engineModeAlerts",
  signal_blocked: "autopilotBlocked",
};

let cachedClient: Expo | null = null;

/** Lazily constructed so a missing EXPO_ACCESS_TOKEN doesn't crash module load -- push
 * just silently no-ops (with a log) until it's configured, same "off by default until
 * configured" pattern as the TradingView webhook and the kill switch. */
function client(): Expo {
  if (!cachedClient) cachedClient = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });
  return cachedClient;
}

export interface NotificationPayload {
  category: NotificationCategory;
  title: string;
  body: string;
  /** Extra structured data delivered alongside the notification (e.g. signal id, pair) --
   * read by the mobile app's notification-tap handler to deep-link into the right screen. */
  data?: Record<string, unknown>;
  /** Only buy_signal/sell_signal are gated by a device's minConfidence; omit for others. */
  confidence?: number;
}

function eligibleDevices(payload: NotificationPayload): PushDevice[] {
  const prefKey = PREF_KEY_FOR_CATEGORY[payload.category];
  return deviceStore.all().filter((device) => {
    // Falls back to the default when a device's stored prefs blob predates this
    // category (jsonb, so an old row simply doesn't have the key yet) -- an explicit
    // `false` the operator actually set is still respected, only a genuinely-missing
    // key falls through to the default, same "new category defaults apply until
    // overridden" posture as a freshly registered device gets via DEFAULT_NOTIFICATION_
    // PREFS in deviceStore.ts's own registration path.
    const enabled = device.notificationPrefs[prefKey] ?? DEFAULT_NOTIFICATION_PREFS[prefKey];
    if (!enabled) return false;
    if (payload.confidence !== undefined && payload.confidence < device.notificationPrefs.minConfidence) return false;
    return true;
  });
}

/**
 * Sends a push notification to every registered device whose prefs allow this category
 * (and, for signal categories, whose minConfidence is met). Best-effort: errors are
 * logged, never thrown -- a push failure must never take down the signal engine or
 * execution path that triggered it. Invalid tokens (DeviceNotRegistered) are pruned from
 * deviceStore so a stale/uninstalled device stops being retried on every future signal.
 */
export async function sendNotification(payload: NotificationPayload): Promise<void> {
  const devices = eligibleDevices(payload);
  if (devices.length === 0) return;

  const validDevices = devices.filter((d) => Expo.isExpoPushToken(d.pushToken));
  if (validDevices.length === 0) return;

  const messages: ExpoPushMessage[] = validDevices.map((device) => ({
    to: device.pushToken,
    title: payload.title,
    body: payload.body,
    data: { category: payload.category, ...payload.data },
    sound: "default",
    priority: "high",
  }));

  const expo = client();
  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          const message = chunk[i];
          const token = Array.isArray(message.to) ? message.to[0] : message.to;
          if (token) deviceStore.removeByToken(token);
        }
      });
    } catch (error) {
      console.error(`[push] failed to send ${payload.category} notification:`, error);
    }
  }
}
