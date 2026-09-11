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
async function postToWebhook(url: string, payload: NotificationPayload): Promise<void> {
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

/** For the rare caller that already knows exactly which account's webhook this event
 * belongs to (none left as of 2026-09-11 -- see forwardToAllConfiguredWebhooks below --
 * but kept as a real, tested building block rather than folded away). */
export async function sendWebhookNotification(payload: NotificationPayload, account: AccountKey = "live"): Promise<void> {
  const url = loadExecutionConfig(account).alertWebhookUrl;
  if (!url) return;
  await postToWebhook(url, payload);
}

/**
 * The real fix for a confirmed gap (2026-09-11): a genuinely good Telegram/Discord
 * setup means EVERY notification category reaches it, not just the handful of call
 * sites someone remembered to also wire up individually. Before this, sendNotification
 * (pushNotifier.ts) had ~35 call sites across the app, but only 4 of them (trade closed,
 * cooldown, daily-loss halt) separately also called sendWebhookNotification -- signals,
 * trade-opened, order-rejected, connection alerts, the new LIVE-recovery notifications,
 * session/digest alerts, and more never reached the webhook at all, silently, with no
 * error to notice.
 *
 * Now called ONCE, automatically, from sendNotification itself -- no individual call
 * site needs to remember anything. Sends to every account (live, demo) that has its own
 * alertWebhookUrl configured, deduplicated by URL (so a shared URL across both accounts,
 * unlikely but possible, never double-posts). Unlike push, this deliberately has no
 * per-category opt-out yet -- there's one recipient (the operator's own bot chat), not a
 * fleet of registered devices with their own preferences, so "send everything" is the
 * right default until a real reason to filter shows up.
 */
export async function forwardToAllConfiguredWebhooks(payload: NotificationPayload): Promise<void> {
  const accounts: AccountKey[] = ["live", "demo"];
  const urls = new Set<string>();
  for (const account of accounts) {
    const url = loadExecutionConfig(account).alertWebhookUrl;
    if (url) urls.add(url);
  }
  if (urls.size === 0) return;
  await Promise.all([...urls].map((url) => postToWebhook(url, payload)));
}
