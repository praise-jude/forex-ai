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
// After this many escalations in a row without ever seeing a genuinely live tick in
// between, a soft forceReconnect clearly isn't fixing it (whether it throws outright, or
// "succeeds" but the connection goes bad again within another STUCK_THRESHOLD_MS) --
// escalate to restarting the whole process instead of retrying the same fix forever.
// Railway restarts a crashed service automatically, so this automates the one thing that
// has reliably fixed a truly stuck connection tonight: a full manual redeploy.
const MAX_SOFT_ATTEMPTS = 2;

const globalKey = Symbol.for("forex-ai.connectionWatchdog");
type GlobalWithState = typeof globalThis & {
  [globalKey]?: { unhealthySince: Map<AccountKey, number>; consecutiveEscalations: Map<AccountKey, number>; started: boolean };
};
const g = globalThis as GlobalWithState;
const state = g[globalKey] ?? (g[globalKey] = { unhealthySince: new Map(), consecutiveEscalations: new Map(), started: false });

/** Used by tests to reset the module-level escalation state between cases. */
export function resetConnectionWatchdogForTests(): void {
  state.unhealthySince.clear();
  state.consecutiveEscalations.clear();
}

/** Exported for tests -- exercises exactly one poll tick's worth of escalation logic. */
export async function checkOnce(accountKey: AccountKey): Promise<void> {
  const { status } = getConnectionStatus(accountKey);
  if (status === "live") {
    state.unhealthySince.delete(accountKey);
    // A real, observed "live" tick is the only thing that counts as genuine recovery --
    // resets the escalation count so a later, unrelated stuck episode gets its own full
    // set of soft attempts rather than inheriting an old failure streak.
    state.consecutiveEscalations.delete(accountKey);
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
  const attempt = (state.consecutiveEscalations.get(accountKey) ?? 0) + 1;
  state.consecutiveEscalations.set(accountKey, attempt);
  console.error(`[market] ${accountKey} connection unhealthy for over ${STUCK_THRESHOLD_MS / 1000}s -- escalation attempt ${attempt}`);

  if (attempt > MAX_SOFT_ATTEMPTS) {
    console.error(
      `[market] ${accountKey} still unhealthy after ${MAX_SOFT_ATTEMPTS} soft reconnect attempts -- restarting the process for a clean slate`
    );
    await sendNotification({
      category: "connection_alert",
      title: "JUDE AI — restarting to clear a stuck connection",
      body: `The ${accountKey} connection stayed broken through ${MAX_SOFT_ATTEMPTS} automatic reconnect attempts, so the app is restarting itself for a clean slate. It should be back within a minute or two.`,
    });
    process.exit(1);
    // Unreachable in production (process.exit terminates immediately), but process.exit
    // is not guaranteed synchronous and is stubbed out in tests -- an explicit return
    // ensures this tick never falls through into attempting forceReconnect anyway.
    return;
  }

  try {
    await forceReconnect(accountKey);
    console.log(`[market] ${accountKey} forced reconnect succeeded (attempt ${attempt})`);
  } catch (error) {
    console.error(`[market] ${accountKey} forced reconnect failed (attempt ${attempt}):`, error);
    void sendNotification({
      category: "connection_alert",
      title: `JUDE AI — ${accountKey.toUpperCase()} reconnect failed`,
      body:
        attempt < MAX_SOFT_ATTEMPTS
          ? `Attempt ${attempt} failed. Will try again, then restart automatically if it's still stuck.`
          : `Attempt ${attempt} failed. The app will restart itself automatically if this happens once more.`,
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
