import { eq } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { autopilotLockState } from "../db/tradingSchema";

const SINGLETON_ID = "singleton";

// A dedicated switch, same globalThis-singleton shape as engineMode.ts's own state, but
// a DIFFERENT lock and a deliberately narrower scope: this only gates
// autoExecutionListener.ts (opening a NEW trade automatically). Manual Buy/Sell clicks,
// the TradingView webhook, and existing-position management (break-even/trailing/
// invalidation-close) all stay unaffected -- "lock the autopilot" means "stop it from
// opening trades on its own", not "stop me from trading too" (that's the kill switch)
// and not "abandon positions already open" (positionManager.ts already runs independent
// of both switches for that reason).
//
// One switch, not per-account -- the operator's own mental model here is "the autopilot"
// as a single thing to lock, unlike the kill switch's existing live/demo split.
//
// UNLIKE engineMode.ts's mode (which always boots back to the safe ANALYSIS default on
// every restart, by design), a lock IS itself the safe state -- so this one really is
// restored from the DB at boot (see hydrateAutopilotLock, called from bootstrap.ts)
// rather than always defaulting to unlocked. A Railway redeploy's ephemeral filesystem
// is exactly why this is DB-backed at all instead of a plain file (this app's earlier
// kill-switch-style approach here would've silently unlocked on every deploy).
interface AutopilotLockGlobalState {
  locked: boolean;
}

const globalKey = Symbol.for("forex-ai.autopilotLock");
type GlobalWithState = typeof globalThis & { [globalKey]?: AutopilotLockGlobalState };
const g = globalThis as GlobalWithState;

// Defaults unlocked -- today's existing behavior -- until hydrateAutopilotLock() (or a
// fresh lock/unlock call) says otherwise. No-DB-config deployments simply keep this
// in-memory default for the life of the process, same posture as every other in-memory
// store in this app when DATABASE_URL isn't set.
const state: AutopilotLockGlobalState = g[globalKey] ?? (g[globalKey] = { locked: false });

async function persistLocked(locked: boolean): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  const row = { id: SINGLETON_ID, locked, updatedAt: new Date() };
  await db
    .insert(autopilotLockState)
    .values(row)
    .onConflictDoUpdate({ target: autopilotLockState.id, set: row })
    .catch((error: unknown) => console.error("[autopilotLock] failed to persist:", error));
}

export function isAutopilotLocked(): boolean {
  return state.locked;
}

export function lockAutopilot(): void {
  state.locked = true;
  void persistLocked(true);
}

export function unlockAutopilot(): void {
  state.locked = false;
  void persistLocked(false);
}

/** Called once from bootstrap.ts, after the module-level default above has already put
 * `state.locked` at false for this fresh process. Restores whatever was last persisted --
 * unlike engineMode.ts's identically-shaped hydrate step, this ACTUALLY applies the
 * restored value (rather than only using it to decide whether to send a notification),
 * because staying locked across a restart is the safe behavior here, not a risk to
 * guard against. No-ops silently when DATABASE_URL isn't set, same as every other DB
 * touch in this codebase. */
export async function hydrateAutopilotLock(): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  try {
    const rows = await db.select().from(autopilotLockState).where(eq(autopilotLockState.id, SINGLETON_ID)).limit(1);
    if (rows[0]) state.locked = rows[0].locked;
  } catch (error) {
    console.error("[autopilotLock] failed to hydrate:", error);
  }
}

/** Only used by tests -- resets back to the safe default between test cases. */
export function resetAutopilotLockForTests(): void {
  state.locked = false;
}
