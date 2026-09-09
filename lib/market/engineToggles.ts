import { getOptionalDb } from "../db/optionalClient";
import { engineToggleState } from "../db/tradingSchema";
import type { AccountKey } from "./types";

export type ToggleableEngine = "range_engine" | "trend_continuation";

/**
 * A real dashboard on/off switch for a detection-only engine, replacing the env-var-
 * only posture Range Engine (and, on launch, Trend Continuation) shipped with -- an
 * operator request (2026-09-09) after being told "there's no button for this, only an
 * env var" for the new Trend Continuation engine. DB-persisted (unlike the Auto-Execute
 * Floor dropdown in executionPolicy.ts, which is deliberately in-memory-only) -- these
 * engines are already gated behind autopilot lock, engine mode, and every other real
 * risk check, so losing this specific override across a Railway redeploy would just
 * silently undo an explicit operator choice for no safety benefit, unlike engine mode's
 * own deliberate always-reset-to-ANALYSIS behavior.
 *
 * A row's ABSENCE means "no override yet" -- executionConfig.ts's loadExecutionConfig
 * falls back to the env var default in that case, exactly as before this feature
 * existed. This table only ever holds an EXPLICIT operator choice, never a default, so
 * there is no ambiguity between "never configured" and "explicitly turned off".
 */

const globalKey = Symbol.for("forex-ai.engineToggles");
type GlobalWithState = typeof globalThis & { [globalKey]?: Map<string, boolean> };
const g = globalThis as GlobalWithState;

// Keyed by `${account}:${engine}` -- one flat map covers every account/engine
// combination without a nested structure to keep in sync.
const overrides: Map<string, boolean> = g[globalKey] ?? (g[globalKey] = new Map());

function keyFor(account: AccountKey, engine: ToggleableEngine): string {
  return `${account}:${engine}`;
}

/** Null means "no override -- use the env var default", exactly like a missing row. */
export function getEngineToggleOverride(account: AccountKey, engine: ToggleableEngine): boolean | null {
  const key = keyFor(account, engine);
  return overrides.has(key) ? (overrides.get(key) ?? null) : null;
}

async function persistToggle(account: AccountKey, engine: ToggleableEngine, enabled: boolean): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  const row = { id: keyFor(account, engine), enabled, updatedAt: new Date() };
  await db
    .insert(engineToggleState)
    .values(row)
    .onConflictDoUpdate({ target: engineToggleState.id, set: row })
    .catch((error: unknown) => console.error(`[engineToggles] failed to persist ${row.id}:`, error));
}

/** Explicit operator action -- sets an override that persists across restarts. There is
 * deliberately no "clear override, go back to the env var default" action exposed
 * anywhere: once an operator has made an explicit choice here, it stays explicit. */
export function setEngineToggle(account: AccountKey, engine: ToggleableEngine, enabled: boolean): void {
  overrides.set(keyFor(account, engine), enabled);
  void persistToggle(account, engine, enabled);
}

/** Called once from bootstrap.ts, restoring whatever was last explicitly set so a
 * restart doesn't silently drop back to the env var default. No-ops silently when
 * DATABASE_URL isn't set, same as every other DB touch in this codebase. */
export async function hydrateEngineToggles(): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  try {
    const rows = await db.select().from(engineToggleState);
    for (const row of rows) overrides.set(row.id, row.enabled);
  } catch (error) {
    console.error("[engineToggles] failed to hydrate:", error);
  }
}

/** Only used by tests -- resets back to "no overrides" between test cases. */
export function resetEngineTogglesForTests(): void {
  overrides.clear();
}
