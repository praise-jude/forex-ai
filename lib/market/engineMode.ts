import { eq } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { engineModeState } from "../db/tradingSchema";
import type { AccountKey } from "./types";
import { sendNotification } from "./pushNotifier";

export type EngineMode = "analysis" | "demo" | "live";

const SINGLETON_ID = "singleton";

// Best-effort, fire-and-forget -- never lets a DB hiccup affect the in-memory mode
// switch itself, same posture as tradeJournal.ts's own persistEntry. This alone is NOT
// how mode gets restored after a restart (see the unconditional "analysis" default below
// for why it must never auto-restore LIVE) -- it exists so checkEngineModeAfterRestart
// can tell "what was this set to right before the process that just booted" apart from
// "the app has never run before" (and, for DEMO specifically, checkEngineModeAfterRestart
// itself is what actually re-arms it -- this function just records the outcome either way).
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

// Always boots to "analysis" -- this is the actual safety mechanism for "never silently
// persist LIVE across a restart". There is no read path from disk/env/db on module load,
// only this literal, so a full process restart gets a fresh globalThis heap and this line
// reruns and wins every time -- identically to every other in-memory store in this app
// (positionStore, riskState, signalStore, ...) resetting on restart. checkEngineModeAfterRestart
// below runs moments later and is the ONE place allowed to move mode off this default before
// any real analysis/execution has had a chance to happen -- and only ever to "demo" (see its
// own doc comment for why DEMO, unlike LIVE, is safe to auto-resume this way).
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
 * bootstrap, a listener, or any timer/retry. The ONE other sanctioned path to "live"
 * is resumeLiveModeAfterRestart below, which re-arms a mode the operator had ALREADY
 * explicitly confirmed before a self-restart dropped it -- and only after
 * liveModeRecovery.ts's full connection-stability / equity / risk / restart-loop
 * gauntlet has passed.
 */
export function enableLiveMode(confirmationPhrase: string): { ok: true } | { ok: false; error: string } {
  if (confirmationPhrase.trim() !== LIVE_CONFIRMATION_PHRASE) {
    return { ok: false, error: "confirmation phrase did not match -- live mode NOT enabled" };
  }
  state.mode = "live";
  void persistMode("live");
  return { ok: true };
}

/**
 * The SECOND (and only other) sanctioned way mode becomes "live" -- see enableLiveMode's
 * doc comment. Deliberately separate from it, and with no phrase check, so that a grep
 * for enableLiveMode still shows exactly one caller (the route) and this restart-recovery
 * path is audited on its own terms.
 *
 * MUST ONLY be called by liveModeRecovery.ts, and only after every one of its guard
 * conditions holds: the previous persisted mode was "live" (the operator had already
 * typed the phrase for this session), the MT5 connection has been continuously healthy
 * for several minutes, equity is positive, no risk halt/cooldown is awaiting review, and
 * the app is not in a restart loop. It re-arms a decision the operator already made; it
 * never makes that decision itself.
 */
export function resumeLiveModeAfterRestart(): void {
  state.mode = "live";
  void persistMode("live");
}

/** Only used by tests -- resets mode back to the safe default between test cases. */
export function resetEngineModeForTests(): void {
  state.mode = "analysis";
}

// A real production pattern (weeks of it, confirmed 2026-09-01): the ONE notification
// checkEngineModeAfterRestart sends when a restart drops mode out of LIVE/DEMO is easy to
// lose in a chaotic incident night -- and this app restarts a lot (see
// metaApiConnection.ts's own connection-instability history). Once missed, nothing ever
// reminded anyone that autopilot was still sitting in ANALYSIS days later, generating
// signals but executing nothing -- confirmed directly against production data: mean-
// reversion signals that should have auto-fired on demo simply never did, for days, with
// zero notification after the initial one. This is the fix: a recurring, impossible-to-
// permanently-miss reminder for as long as mode stays in ANALYSIS, instead of a single
// ping that only fires at the moment of the reset itself.
// Tightened from 6h -> 30min on 2026-09-01, same day as the fix (see
// metaApiConnection.ts's circuit breaker) for what was ACTUALLY causing mode to keep
// dropping: not a flaw in this file, but this account force-restarting constantly from a
// self-sustaining rate-limit storm. With restarts now rare instead of near-continuous, a
// tighter reminder costs almost nothing in practice (it only ever fires while mode is
// genuinely sitting on ANALYSIS) but closes the gap much faster on the rare restart that
// still does drop it.
const ANALYSIS_REMINDER_INTERVAL_MS = 30 * 60 * 1000;

interface ReminderState {
  intervalStarted: boolean;
}
const reminderGlobalKey = Symbol.for("forex-ai.engineMode.reminder");
type GlobalWithReminderState = typeof globalThis & { [reminderGlobalKey]?: ReminderState };
const gReminder = globalThis as GlobalWithReminderState;
const reminderState: ReminderState = gReminder[reminderGlobalKey] ?? (gReminder[reminderGlobalKey] = { intervalStarted: false });

/**
 * Called once from bootstrap.ts, right after checkEngineModeAfterRestart. Fires a gentle
 * "autopilot still isn't auto-trading" push every ANALYSIS_REMINDER_INTERVAL_MS for as
 * long as mode remains ANALYSIS -- deliberately unconditional on WHY it's ANALYSIS
 * (a restart reset it, or a human genuinely chose it) rather than trying to track that
 * distinction: either way, "no auto-trading is currently happening" is the one true fact
 * worth periodically resurfacing, and a human who deliberately wants ANALYSIS for a while
 * loses nothing but one push every 6 hours they can ignore. Silent (no-op) the instant
 * mode moves to DEMO/LIVE -- never fires while auto-trading is actually active.
 */
export function startEngineModeReminder(): void {
  if (reminderState.intervalStarted) return;
  reminderState.intervalStarted = true;
  setInterval(() => {
    if (state.mode !== "analysis") return;
    void sendNotification({
      category: "engine_mode_reset",
      title: "JUDE AI — Autopilot is still Analysis-only",
      body: "No auto-trading is happening -- Engine Mode has been sitting on Analysis. Enable Demo or Live in Settings if this isn't intentional.",
    });
  }, ANALYSIS_REMINDER_INTERVAL_MS);
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
 * persisted right before this restart.
 *
 * LIVE does not resume HERE -- module load already forced `state.mode` to "analysis", so
 * on return from this function auto-execution is off. Whether it comes back is decided
 * separately and conditionally by liveModeRecovery.ts (started right after this in
 * bootstrap.ts, given this function's return value): it re-arms LIVE only once the
 * connection has been continuously healthy for minutes, equity is positive, no risk
 * halt is pending, and the app isn't in a restart loop -- otherwise it stays ANALYSIS
 * and notifies. That's why the "live" branch below neither notifies nor re-persists
 * "analysis": liveModeRecovery owns both, and leaving "live" persisted is what lets a
 * second restart before recovery finishes still know it should be trying to get back.
 *
 * DEMO is different: it trades no real money, and connectionWatchdog.ts's own escalation
 * path (a `process.exit(1)` restart after a stuck MetaApi connection survives two soft
 * reconnects) was routinely taking DEMO auto-trading down for good until a human noticed
 * -- on a deployment with real, recurring connection instability (see this file's own
 * restart-recovery history), that could mean DEMO auto-execution silently sitting off for
 * days between whenever someone happened to check Settings, no different in practice from
 * being permanently disabled. So a restart that was in DEMO auto-resumes it (still with
 * its own, distinctly-worded notification -- this is a real event worth knowing about, not
 * a silent one) rather than requiring the same manual re-arm LIVE deliberately does.
 *
 * For the DEMO and analysis cases, re-persists the resulting mode afterward so a second
 * restart, before anyone has changed anything, doesn't re-notify for the same
 * already-reported transition. Returns the previous persisted mode so bootstrap.ts can
 * hand it to liveModeRecovery.ts. No-ops silently (returns undefined) when DATABASE_URL
 * isn't set, same as every other DB touch in this file.
 */
export async function checkEngineModeAfterRestart(): Promise<EngineMode | undefined> {
  const db = getOptionalDb();
  if (!db) return undefined;

  try {
    const rows = await db.select().from(engineModeState).where(eq(engineModeState.id, SINGLETON_ID)).limit(1);
    const previousMode = rows[0]?.mode as EngineMode | undefined;

    if (previousMode === "demo") {
      state.mode = "demo";
      await sendNotification({
        category: "engine_mode_reset",
        title: "JUDE AI — Demo Auto-Trade resumed after restart",
        body: "A restart (likely clearing a stuck connection) took Engine Mode down. Since DEMO risks no real money, it resumed DEMO auto-trading automatically -- no action needed unless you wanted it off.",
      });
      await persistMode(state.mode);
    } else if (previousMode !== "live") {
      // "analysis" or a first-ever boot -- nothing to restore; keep the persisted row in
      // sync with the fresh default.
      await persistMode(state.mode);
    }
    // previousMode === "live": intentionally NOT persisted over and NOT notified here.
    // liveModeRecovery.ts (called next from bootstrap.ts with this return value) decides
    // whether to conditionally re-arm LIVE or fall back to ANALYSIS with its own
    // notification -- and needs the persisted "live" to survive a second restart mid-recovery.
    return previousMode;
  } catch (error) {
    console.error("[engineMode] failed to check mode across restart:", error);
    return undefined;
  }
}
