import { eq } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { liveRecoveryState as liveRecoveryTable } from "../db/tradingSchema";
import type { EngineMode } from "./engineMode";
import { resumeLiveModeAfterRestart, setEngineMode } from "./engineMode";
import { getAccountInformation, getConnectionStatus, type ConnectionStatus } from "./metaApiConnection";
import { requiresAcknowledgement, riskState } from "./riskState";
import { sendNotification } from "./pushNotifier";

/**
 * Conditionally switches LIVE auto-trade back on after the app restarts ITSELF (the
 * connection watchdog's process.exit(1), or a Railway crash-restart) -- the operator
 * asked not to have to re-type the LIVE confirmation phrase every time an unstable
 * connection forces a restart, while still keeping a human-equivalent safety bar in
 * front of real-money auto-execution.
 *
 * engineMode.ts still boots to ANALYSIS unconditionally; this never changes that. It
 * only re-arms LIVE, and only when EVERY one of these holds:
 *   - the mode persisted right before this restart was already "live" (so the operator
 *     had typed the phrase for this session -- this re-arms their decision, it doesn't
 *     make one),
 *   - the MT5 live connection has been continuously healthy for STABILITY_REQUIRED_MS,
 *   - equity is positive (a real synced account, not a still-warming-up 0),
 *   - no risk halt / consecutive-loss cooldown is awaiting operator review,
 *   - the app is NOT in a restart loop (< LOOP_THRESHOLD boots in LOOP_WINDOW_MS).
 *
 * If the loop check fails, recovery is abandoned immediately with its own notification.
 * If the other conditions never all hold within GIVE_UP_AFTER_MS, recovery gives up and
 * leaves mode on ANALYSIS, again with a notification. Either way the operator can always
 * re-enable LIVE by hand in Settings.
 *
 * Restart-loop detection needs boot timestamps to survive the restarts it's counting, so
 * they live in the live_recovery_state table (one row). A missing/unmigrated table or no
 * DATABASE_URL degrades to "loop detection off" -- the connection-stability gate above is
 * the primary protection regardless, and it alone already prevents re-arming LIVE during
 * a genuine loop (a looping connection never stays healthy for minutes at a stretch).
 */

const LOOP_WINDOW_MS = 30 * 60_000;
// This boot + 2 earlier ones inside the window = a loop. A single isolated
// downgrade/restart cycle produces 1; the watchdog's own escalation ladder tops out at
// 2 soft attempts before it restarts the process, so 3 in half an hour means the
// restarts themselves aren't fixing anything.
const LOOP_THRESHOLD = 3;
const STABILITY_REQUIRED_MS = 3 * 60_000;
const CHECK_INTERVAL_MS = 20_000;
const GIVE_UP_AFTER_MS = 25 * 60_000;
const MAX_TRACKED_BOOTS = 10;

export type LiveRecoveryPhase = "idle" | "pending" | "resumed" | "gave_up" | "loop_blocked";

export interface LiveRecoveryStatus {
  phase: LiveRecoveryPhase;
  /** Human-readable "what's still blocking the re-arm", only meaningful while pending. */
  waitingOn: string | null;
  /** Epoch ms this phase was entered. */
  since: number;
}

interface RecoveryRuntimeState {
  started: boolean;
  status: LiveRecoveryStatus;
  connectionHealthySinceMs: number | null;
  startedAtMs: number;
  timer: ReturnType<typeof setInterval> | null;
}

const globalKey = Symbol.for("forex-ai.liveModeRecovery");
type GlobalWithState = typeof globalThis & { [globalKey]?: RecoveryRuntimeState };
const g = globalThis as GlobalWithState;
const runtime: RecoveryRuntimeState =
  g[globalKey] ??
  (g[globalKey] = {
    started: false,
    status: { phase: "idle", waitingOn: null, since: Date.now() },
    connectionHealthySinceMs: null,
    startedAtMs: 0,
    timer: null,
  });

function setPhase(phase: LiveRecoveryPhase, waitingOn: string | null): void {
  if (runtime.status.phase === phase && runtime.status.waitingOn === waitingOn) return;
  runtime.status = { phase, waitingOn, since: Date.now() };
}

/** Read by /api/system-alerts so the dashboard bell can show "LIVE is being restored". */
export function getLiveRecoveryStatus(): LiveRecoveryStatus {
  return runtime.status;
}

// --- Pure helpers (unit-tested directly) ---

/** Appends this boot and drops anything well outside the loop window, capped at
 * MAX_TRACKED_BOOTS. Kept a little wider than LOOP_WINDOW_MS so a boot right at the edge
 * still has neighbours to compare against. */
export function recordBoot(recentBootsMs: number[], nowMs: number): number[] {
  const kept = recentBootsMs.filter((t) => Number.isFinite(t) && nowMs - t < LOOP_WINDOW_MS * 2 && t <= nowMs);
  return [...kept, nowMs].slice(-MAX_TRACKED_BOOTS);
}

/** `recentBootsMs` must already include the current boot (via recordBoot). */
export function isRestartLoop(recentBootsMs: number[], nowMs: number): boolean {
  return recentBootsMs.filter((t) => nowMs - t < LOOP_WINDOW_MS).length >= LOOP_THRESHOLD;
}

export interface RecoveryReadinessInput {
  connectionStatus: ConnectionStatus;
  connectionHealthySinceMs: number | null;
  equity: number | undefined;
  requiresRiskAck: boolean;
  nowMs: number;
}

/** The full "is it safe to re-arm LIVE right now" gate, as a pure function. */
export function liveRecoveryReadiness(input: RecoveryReadinessInput): { ready: boolean; waitingOn: string | null } {
  if (input.connectionStatus !== "live" || input.connectionHealthySinceMs === null) {
    return { ready: false, waitingOn: "a stable MT5 connection" };
  }
  if (input.nowMs - input.connectionHealthySinceMs < STABILITY_REQUIRED_MS) {
    return { ready: false, waitingOn: "the MT5 connection to stay stable for a few minutes" };
  }
  if ((input.equity ?? 0) <= 0) {
    return { ready: false, waitingOn: "the account balance to finish syncing" };
  }
  if (input.requiresRiskAck) {
    return { ready: false, waitingOn: "the risk halt / cooldown to be reviewed" };
  }
  return { ready: true, waitingOn: null };
}

// --- DB-backed boot log (best-effort) ---

const ROW_ID = "singleton";

async function loadRecentBoots(): Promise<number[]> {
  const db = getOptionalDb();
  if (!db) return [];
  try {
    const rows = await db.select().from(liveRecoveryTable).where(eq(liveRecoveryTable.id, ROW_ID)).limit(1);
    const raw = rows[0]?.recentBootsMs;
    return Array.isArray(raw) ? raw.filter((t): t is number => typeof t === "number") : [];
  } catch (error) {
    console.error("[liveModeRecovery] could not read boot log (loop detection disabled this boot):", error);
    return [];
  }
}

async function saveRecentBoots(recentBootsMs: number[]): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  try {
    const row = { id: ROW_ID, recentBootsMs, updatedAt: new Date() };
    await db.insert(liveRecoveryTable).values(row).onConflictDoUpdate({ target: liveRecoveryTable.id, set: row });
  } catch (error) {
    console.error("[liveModeRecovery] could not persist boot log:", error);
  }
}

// --- Orchestration ---

function evaluateOnce(): void {
  const conn = getConnectionStatus("live");
  const account = getAccountInformation("live");
  const now = Date.now();

  if (conn.status === "live") {
    runtime.connectionHealthySinceMs ??= now;
  } else {
    runtime.connectionHealthySinceMs = null;
  }

  const dayState = account ? riskState.current(now, account.equity, "live") : null;
  const readiness = liveRecoveryReadiness({
    connectionStatus: conn.status,
    connectionHealthySinceMs: runtime.connectionHealthySinceMs,
    equity: account?.equity,
    requiresRiskAck: dayState ? requiresAcknowledgement(dayState) : false,
    nowMs: now,
  });

  if (readiness.ready) {
    stopTimer();
    resumeLiveModeAfterRestart();
    setPhase("resumed", null);
    void sendNotification({
      category: "engine_mode_reset",
      title: "JUDE AI — LIVE auto-trade restored",
      body: "The MT5 connection has been stable since the restart, so LIVE auto-trade has been switched back on automatically. Turn it off in Settings if you didn't want that.",
    });
    return;
  }

  if (now - runtime.startedAtMs >= GIVE_UP_AFTER_MS) {
    stopTimer();
    setEngineMode("analysis"); // persists "analysis" -- stop trying on the next restart too
    setPhase("gave_up", readiness.waitingOn);
    void sendNotification({
      category: "engine_mode_reset",
      title: "JUDE AI — LIVE not restored after restart",
      body: `Conditions didn't stay healthy long enough to safely switch LIVE back on (waiting on ${readiness.waitingOn}). Auto-trading is OFF — re-enable LIVE in Settings when you're ready.`,
    });
    return;
  }

  setPhase("pending", readiness.waitingOn);
}

function stopTimer(): void {
  if (runtime.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }
}

/**
 * Called once from bootstrap.ts, right after checkEngineModeAfterRestart, with that
 * function's return value (the mode persisted before this restart). Records the boot for
 * loop detection regardless of mode; only starts the re-arm watcher when the previous
 * mode was "live".
 */
export async function startLiveModeRecovery(previousMode: EngineMode | undefined): Promise<void> {
  if (runtime.started) return;
  runtime.started = true;

  const now = Date.now();
  const recentBoots = recordBoot(await loadRecentBoots(), now);
  void saveRecentBoots(recentBoots);

  if (previousMode !== "live") {
    setPhase("idle", null);
    return;
  }

  if (isRestartLoop(recentBoots, now)) {
    setEngineMode("analysis"); // persists "analysis" so recovery doesn't retry next boot
    setPhase("loop_blocked", null);
    const count = recentBoots.filter((t) => now - t < LOOP_WINDOW_MS).length;
    void sendNotification({
      category: "engine_mode_reset",
      title: "JUDE AI — LIVE staying OFF (restart loop)",
      body: `The app has restarted ${count} times in the last ${Math.round(LOOP_WINDOW_MS / 60_000)} minutes, so LIVE auto-trade was NOT switched back on automatically. Check the MT5 connection, then re-enable LIVE in Settings once it's stable.`,
    });
    return;
  }

  runtime.startedAtMs = now;
  runtime.connectionHealthySinceMs = getConnectionStatus("live").status === "live" ? now : null;
  setPhase("pending", "a stable MT5 connection");
  void sendNotification({
    category: "engine_mode_reset",
    title: "JUDE AI — Restoring LIVE after restart",
    body: "LIVE auto-trade will switch back on automatically once the MT5 connection has been stable for a few minutes. Re-enable it yourself in Settings if you'd rather not wait.",
  });

  stopTimer();
  runtime.timer = setInterval(evaluateOnce, CHECK_INTERVAL_MS);
  // Kick one evaluation slightly ahead of the first interval tick so a fast, clean
  // reconnect doesn't sit idle for a full CHECK_INTERVAL_MS before the clock even starts.
  setTimeout(evaluateOnce, 5_000);
}

/** Test-only: clear module state between cases. */
export function resetLiveModeRecoveryForTests(): void {
  stopTimer();
  runtime.started = false;
  runtime.status = { phase: "idle", waitingOn: null, since: Date.now() };
  runtime.connectionHealthySinceMs = null;
  runtime.startedAtMs = 0;
}
