import { loadExecutionConfig } from "./executionConfig";
import type { NotificationPayload } from "./pushNotifier";
import type { AccountKey } from "./types";

/**
 * A second, app-independent alert channel alongside Expo push: POSTs every notification
 * payload to an operator-configured webhook (a Telegram bot "sendMessage" URL, a Discord
 * channel webhook, or any HTTPS endpoint that accepts a JSON body). Redundant on purpose
 * -- a missed phone push should never mean a missed trade event.
 *
 * Best-effort, same posture as pushNotifier: errors are logged, never thrown, so a
 * webhook outage can never take down the signal engine or execution path that triggered
 * it. Disabled entirely (silently) when no ALERT_WEBHOOK_URL is configured -- same
 * "off until explicitly configured" pattern as the TradingView webhook secret.
 *
 * Discord accepts { content } natively; Telegram's sendMessage accepts { text }. We send
 * a superset body ({ text, content, ...structured fields }) so both work with zero
 * per-provider branching, and any other endpoint still gets the full structured payload.
 */
export async function sendWebhookNotification(payload: NotificationPayload, account: AccountKey = "live"): Promise<void> {
  const url = loadExecutionConfig(account).alertWebhookUrl;
  if (!url) return;

  const text = payload.body ? `${payload.title}\n${payload.body}` : payload.title;
  const body = {
    text, // Telegram
    content: text, // Discord
    category: payload.category,
    title: payload.title,
    body: payload.body,
    ...(payload.data ? { data: payload.data } : {}),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error(`[webhook] alert POST failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`[webhook] alert POST error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
