import { getConnectionStatus, forceReconnect, isAccountConfigured } from "./metaApiConnection";
import { sendNotification } from "./pushNotifier";
import type { AccountKey } from "./types";

const POLL_INTERVAL_MS = 30_000;
// Long enough that ordinary transient reconnects (self-resolve within seconds, per
// every occurrence observed in production tonight) never trigger this -- short enough
// that a genuinely stuck connection (the SDK-level resync loop that has needed a manual
// `railway redeploy` several times) gets a real chance at automatic recovery instead of
// silently sitting broken until a human happens to notice.
const STUCK_THRESHOLD_MS = 3 * 60 * 1000;

const globalKey = Symbol.for("forex-ai.connectionWatchdog");
type GlobalWithState = typeof globalThis & { [globalKey]?: { unhealthySince: Map<AccountKey, number>; started: boolean } };
const g = globalThis as GlobalWithState;
const state = g[globalKey] ?? (g[globalKey] = { unhealthySince: new Map(), started: false });

async function checkOnce(accountKey: AccountKey): Promise<void> {
  const { status } = getConnectionStatus(accountKey);
  if (status === "live") {
    state.unhealthySince.delete(accountKey);
    return;
  }

  const since = state.unhealthySince.get(accountKey);
  if (since === undefined) {
    state.unhealthySince.set(accountKey, Date.now());
    return;
  }
  if (Date.now() - since < STUCK_THRESHOLD_MS) return;

  // Cleared immediately, before the reconnect attempt even starts -- forceReconnect
  // itself can take a while, and this must not re-trigger on every subsequent tick
  // while one is already in flight.
  state.unhealthySince.delete(accountKey);
  console.error(`[market] ${accountKey} connection unhealthy for over ${STUCK_THRESHOLD_MS / 1000}s -- forcing a fresh reconnect`);

  try {
    await forceReconnect(accountKey);
    console.log(`[market] ${accountKey} forced reconnect succeeded`);
  } catch (error) {
    console.error(`[market] ${accountKey} forced reconnect failed:`, error);
    void sendNotification({
      category: "connection_alert",
      title: `JUDE AI — ${accountKey.toUpperCase()} reconnect failed`,
      body: `The connection was stuck for over ${Math.round(STUCK_THRESHOLD_MS / 60000)} minutes and an automatic reconnect attempt failed. A manual redeploy may be needed.`,
    });
  }
}

/**
 * Called once from bootstrap.ts. The self-healing counterpart to connectionWatcher.ts
 * (which only ever notifies on a status transition, never acts) -- this one actually
 * intervenes once a connection has been stuck unhealthy long enough that it's very
 * unlikely to recover on its own. Covers "live" always, "demo" only when configured,
 * same posture as bootstrap.ts's own account-configured checks elsewhere.
 */
export function startConnectionWatchdog(): void {
  if (state.started) return;
  state.started = true;
  setInterval(() => {
    void checkOnce("live");
    if (isAccountConfigured("demo")) void checkOnce("demo");
  }, POLL_INTERVAL_MS);
}
