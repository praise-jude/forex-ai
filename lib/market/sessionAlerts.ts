import { isKillzone } from "./sessions";
import { sendNotification } from "./pushNotifier";

// How often the killzone boundary is re-checked. Session windows only ever change on a
// clock-hour boundary (see sessions.ts's LONDON/NEW_YORK configs), so this only needs to
// be frequent enough that the announcement lands within a minute or two of the real
// transition -- no reason to poll every few seconds the way a price-driven check would.
const POLL_INTERVAL_MS = 60 * 1000;

interface SessionAlertState {
  started: boolean;
  /** Undefined until the first check ever runs -- deliberately distinct from a real
   * true/false, so that first check only RECORDS the current state instead of treating
   * "unknown -> known" as a transition worth announcing. Without this, every restart/
   * redeploy would fire a spurious "killzone opened!" notification the moment the
   * process boots mid-killzone, same class of bug engineMode.ts's own restart handling
   * is built to avoid. */
  lastIsKillzone: boolean | undefined;
}

const globalKey = Symbol.for("forex-ai.sessionAlerts");
type GlobalWithState = typeof globalThis & { [globalKey]?: SessionAlertState };
const g = globalThis as GlobalWithState;
const state: SessionAlertState = g[globalKey] ?? (g[globalKey] = { started: false, lastIsKillzone: undefined });

/**
 * Purely informational -- narrates when the London/NY killzone gate (see sessions.ts)
 * opens or closes, the exact real-world confusion point from today's "why is nothing
 * firing" conversations. Never touches execution: this only ever calls sendNotification,
 * the same one-way narration channel autoExecutionListener.ts's signal_blocked category
 * already uses. Deliberately collapses London/NY into a single "killzone" on/off signal
 * rather than announcing each session by name -- from the operator's own "will trades
 * fire" perspective the two are interchangeable (both allow FX/gold entries equally),
 * so a London->NY handoff isn't actually new information worth a separate ping.
 */
function checkSessionTransition(): void {
  const nowKillzone = isKillzone(Date.now());
  const wasKillzone = state.lastIsKillzone;
  state.lastIsKillzone = nowKillzone;

  if (wasKillzone === undefined || wasKillzone === nowKillzone) return;

  if (nowKillzone) {
    void sendNotification({
      category: "session_alert",
      title: "JUDE AI — Killzone opened",
      body: "The London/New York killzone window just opened -- SMC is now actively watching for new setups on your FX and gold pairs.",
    });
  } else {
    void sendNotification({
      category: "session_alert",
      title: "JUDE AI — Killzone closed",
      body: "Today's killzone window just closed -- SMC won't fire new FX/gold signals until it reopens. BTC/USD is unaffected (crypto trades 24/7).",
    });
  }
}

export function startSessionAlerts(): void {
  if (state.started) return;
  state.started = true;
  checkSessionTransition(); // establishes the baseline silently, see lastIsKillzone's own doc comment
  setInterval(checkSessionTransition, POLL_INTERVAL_MS);
}

/** Only used by tests -- resets back to the fresh-boot default between test cases. */
export function resetSessionAlertsForTests(): void {
  state.started = false;
  state.lastIsKillzone = undefined;
}

/** Exported for the /api/session-status route (and any other reader) -- the exact same
 * live killzone read this module's own interval uses, just without any state tracking. */
export function currentKillzoneStatus(): { isKillzone: boolean } {
  return { isKillzone: isKillzone(Date.now()) };
}
