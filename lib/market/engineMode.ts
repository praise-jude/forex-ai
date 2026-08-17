import { eq } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { engineModeState } from "../db/tradingSchema";
import type { AccountKey } from "./types";
import { sendNotification } from "./pushNotifier";

export type EngineMode = "analysis" | "demo" | "live";

const SINGLETON_ID = "singleton";

// Best-effort, fire-and-forget -- never lets a DB hiccup affect the in-memory mode
// switch itself, same posture as tradeJournal.ts's own persistEntry. This is NOT how
// mode gets restored after a restart (see the unconditional "analysis" default below
// for why it must never auto-restore LIVE) -- it exists solely so
// checkEngineModeAfterRestart can tell "what was this set to right before the process
// that just booted" apart from "the app has never run before".
async function persistMode(mode: EngineMode): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  const row = { id: SINGLETON_ID, mode, updatedAt: new Date() };
  await db
    .insert(engineModeState)
    .values(row)
    .onConflictDoUpdate({ target: engineModeState.id, set: row })
    .catch((error: unknown) => console.error("[engineMode] failed to persist mode:", error));
}

interface EngineModeState {
  mode: EngineMode;
}

const globalKey = Symbol.for("forex-ai.engineMode");
type GlobalWithState = typeof globalThis & { [globalKey]?: EngineModeState };
const g = globalThis as GlobalWithState;

// Always boots to "analysis" -- this is the actual safety mechanism for "never persist
// LIVE (or DEMO) across a restart". There is no read path from disk/env/db on module
// load, only this literal, so a full process restart gets a fresh globalThis heap and
// this line reruns and wins every time -- identically to every other in-memory store in
// this app (positionStore, riskState, signalStore, ...) resetting on restart.
const state: EngineModeState = g[globalKey] ?? (g[globalKey] = { mode: "analysis" });

export function getEngineMode(): EngineMode {
  return state.mode;
}

/** ANALYSIS and DEMO need no special ceremony -- turning auto-execution risk down (or to
 * an account with no real money) is always safe, matching the kill switch's existing
 * "pause needs no confirm, resume does" asymmetry. LIVE must go through enableLiveMode. */
export function setEngineMode(mode: "analysis" | "demo"): void {
  state.mode = mode;
  void persistMode(mode);
}

export const LIVE_CONFIRMATION_PHRASE = "ENABLE LIVE TRADING";

/**
 * The ONLY function in this codebase allowed to set mode "live" -- deliberately not a
 * bare setter. Requires the caller to re-state a fixed phrase, checked server-side
 * (never trust client-only confirmation for this), so a scripted/buggy request body
 * can't flip this by accident the way a bare `{mode:"live"}` could.
 *
 * THIS FUNCTION MUST NEVER BE CALLED FROM ANYWHERE EXCEPT the POST /api/engine-mode
 * route handler, in direct response to an explicit user submission -- never from
 * bootstrap, a listener, or any timer/retry.
 */
export function enableLiveMode(confirmationPhrase: string): { ok: true } | { ok: false; error: string } {
  if (confirmationPhrase.trim() !== LIVE_CONFIRMATION_PHRASE) {
    return { ok: false, error: "confirmation phrase did not match -- live mode NOT enabled" };
  }
  state.mode = "live";
  void persistMode("live");
  return { ok: true };
}

/** Only used by tests -- resets mode back to the safe default between test cases. */
export function resetEngineModeForTests(): void {
  state.mode = "analysis";
}

/** Which account a MANUAL Buy/Sell click targets for a given mode. In ANALYSIS or LIVE
 * mode, a click targets "live" (unchanged from before DEMO mode existed -- ANALYSIS has
 * always meant "no auto-trading, but a manual click still fires for real"). In DEMO
 * mode, a click targets "demo" instead, so testing in DEMO mode can never accidentally
 * place a real order via a manual click. */
export function manualExecutionAccount(mode: EngineMode): AccountKey {
  return mode === "demo" ? "demo" : "live";
}

/** Which account AUTO-EXECUTION should target for a given mode, or null to no-op.
 * ANALYSIS never auto-executes, by definition. */
export function autoExecutionAccount(mode: EngineMode): AccountKey | null {
  if (mode === "analysis") return null;
  return mode;
}

/**
 * Called once from bootstrap.ts, after the module-level default above has already put
 * `state.mode` at "analysis" for this fresh process. Reads back whatever mode was
 * persisted right before this restart -- if that was "demo" or "live", this restart
 * just silently dropped out of it (the intended, unconditional safety behavior, not a
 * bug -- see the "Always boots to analysis" comment above), so a push notification
 * fires to make that visible instead of only being discoverable by chance later.
 * Immediately re-persists "analysis" afterward so a second restart, before anyone has
 * re-enabled LIVE/DEMO, doesn't notify again for the same already-reported drop.
 * No-ops silently when DATABASE_URL isn't set, same as every other DB touch in this file.
 */
export async function checkEngineModeAfterRestart(): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;

  try {
    const rows = await db.select().from(engineModeState).where(eq(engineModeState.id, SINGLETON_ID)).limit(1);
    const previousMode = rows[0]?.mode as EngineMode | undefined;

    if (previousMode === "live" || previousMode === "demo") {
      await sendNotification({
        category: "engine_mode_reset",
        title: "JUDE AI — Engine Mode reset to Analysis",
        body: `A restart dropped Engine Mode from ${previousMode.toUpperCase()} back to ANALYSIS. Auto-trading is OFF until you re-enable it in Settings.`,
      });
    }
  } catch (error) {
    console.error("[engineMode] failed to check mode across restart:", error);
  }

  await persistMode("analysis");
}
