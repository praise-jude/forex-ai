import { getConnectionStatus, type ConnectionStatus } from "./metaApiConnection";
import { sendNotification } from "./pushNotifier";

const POLL_INTERVAL_MS = 30_000;
const globalKey = Symbol.for("forex-ai.connectionWatcher");
type GlobalWithWatcher = typeof globalThis & { [globalKey]?: { lastStatus: ConnectionStatus | null; started: boolean } };
const g = globalThis as GlobalWithWatcher;
const state = g[globalKey] ?? (g[globalKey] = { lastStatus: null, started: false });

function checkOnce(): void {
  const { status } = getConnectionStatus("live");
  const previous = state.lastStatus;
  state.lastStatus = status;

  // Skips the very first read (previous === null) -- that's just startup, not a real
  // transition, and would otherwise fire a spurious "connection lost" on every boot.
  if (previous === null || previous === status) return;

  if (previous === "live" && status !== "live") {
    void sendNotification({
      category: "connection_alert",
      title: "JUDE AI — Connection lost",
      body: `MT5 live connection dropped (${status}). Signal detection and execution may be affected.`,
    });
  } else if (previous !== "live" && status === "live") {
    void sendNotification({
      category: "connection_alert",
      title: "JUDE AI — Connection restored",
      body: "MT5 live connection is back up.",
    });
  }
}

/** Called once from bootstrap.ts. A plain interval, not another MetaApi event
 * subscription -- getConnectionStatus() already reads the full connected/synchronized/
 * connectedToBroker chain, so polling it is enough to catch every transition without
 * duplicating that logic against the SDK's own listener events. */
export function startConnectionWatcher(): void {
  if (state.started) return;
  state.started = true;
  setInterval(checkOnce, POLL_INTERVAL_MS);
}
