import { getEngineMode } from "@/lib/market/engineMode";
import { getAccountInformation, getConnectionStatus } from "@/lib/market/metaApiConnection";
import { requiresAcknowledgement, riskState } from "@/lib/market/riskState";
import { getLiveRecoveryStatus } from "@/lib/market/liveModeRecovery";
import { signalStore } from "@/lib/market/signalStore";
import { positionStore } from "@/lib/market/positionStore";

export const runtime = "nodejs";

// Aggregates the "something the operator should know about is wrong" conditions the
// dashboard bell lights up for. Pure in-memory reads (same posture as
// /api/connection-status and /api/risk-status) -- safe to poll tightly.

type Severity = "critical" | "warning" | "info";

interface SystemAlert {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

const QUALIFYING_SOURCES = new Set(["smc", "mean_reversion", "trend_continuation"]);
const MISSED_SIGNAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Recent buy/strong_buy signals from a real engine that never became a filled trade on
 * the live account -- the "it fired but didn't trade" case. Mirrors
 * maintenanceCheck.ts's getLastQualifiedSignal, widened from "the single latest" to
 * "every one in the last 2h". */
function recentUnexecutedSignals(nowMs: number): { pair: string; tier: string; createdAt: number; wasRejected: boolean }[] {
  const trades = positionStore.all();
  return signalStore
    .all()
    .filter(
      (s) =>
        QUALIFYING_SOURCES.has(s.source) &&
        (s.tier === "buy" || s.tier === "strong_buy") &&
        nowMs - s.createdAt <= MISSED_SIGNAL_WINDOW_MS
    )
    .map((s) => {
      const trade = trades.find((t) => t.signalId === s.id && t.account === "live");
      return { signal: s, trade };
    })
    .filter(({ trade }) => trade?.status !== "filled")
    .map(({ signal, trade }) => ({
      pair: signal.pair,
      tier: signal.tier,
      createdAt: signal.createdAt,
      wasRejected: trade?.status === "rejected",
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function minutesAgo(ms: number, nowMs: number): string {
  const m = Math.max(0, Math.round((nowMs - ms) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 min ago" : `${m} min ago`;
}

export async function GET() {
  const now = Date.now();
  const mode = getEngineMode();
  const conn = getConnectionStatus("live");
  const account = getAccountInformation("live");
  const dayState = account ? riskState.current(now, account.equity, "live") : null;
  const recovery = getLiveRecoveryStatus();

  const alerts: SystemAlert[] = [];

  // 1. Auto-trading not active
  if (recovery.phase === "pending") {
    alerts.push({
      id: "live_recovery_pending",
      severity: "info",
      title: "Restoring LIVE after a restart",
      detail: `Auto-trade will switch back on once the connection is stable — waiting on ${recovery.waitingOn ?? "a stable connection"}.`,
    });
  } else if (recovery.phase === "loop_blocked") {
    alerts.push({
      id: "live_recovery_loop",
      severity: "warning",
      title: "LIVE held OFF — restart loop",
      detail: "The app restarted repeatedly, so LIVE was not switched back on automatically. Re-enable it in Settings once the connection is stable.",
    });
  } else if (mode === "analysis") {
    alerts.push({
      id: "auto_trading_off",
      severity: "warning",
      title: "Auto-trading is OFF",
      detail: "Engine Mode is on ANALYSIS — signals are detected but never placed. Enable LIVE or DEMO to auto-trade.",
    });
  }

  // 2. MT5 connection down
  if (conn.status !== "live") {
    alerts.push({
      id: "connection_down",
      severity: conn.status === "disconnected" ? "critical" : "warning",
      title: conn.status === "disconnected" ? "MT5 disconnected" : "MT5 reconnecting",
      detail:
        conn.status === "disconnected"
          ? "No live MT5 connection. Signal detection and execution are affected until it recovers."
          : "The MT5 connection is re-syncing. Live data may be briefly stale.",
    });
  }

  // 3. Risk halt / cooldown
  if (dayState?.haltedForToday) {
    alerts.push({
      id: "risk_halt",
      severity: "critical",
      title: "Autopilot locked — daily loss limit",
      detail: "The daily loss limit tripped on the live account. No new auto-trades until the next trading day (or a manual force-resume).",
    });
  } else if (dayState?.cooldownUntil && dayState.cooldownUntil > now) {
    alerts.push({
      id: "risk_cooldown",
      severity: "warning",
      title: "Cooldown active",
      detail: `${dayState.consecutiveLosses} consecutive losses on the live account — auto-trading resumes in ${Math.max(1, Math.round((dayState.cooldownUntil - now) / 60_000))} min.`,
    });
  } else if (dayState && requiresAcknowledgement(dayState)) {
    alerts.push({
      id: "risk_ack",
      severity: "warning",
      title: "Paused — awaiting review",
      detail: "A daily-loss halt or cooldown has cleared, but auto-execution stays paused until you resume it from the Risk banner.",
    });
  }

  // 4. Signal fired but not executed (last 2h)
  const missed = recentUnexecutedSignals(now);
  if (missed.length > 0) {
    const latest = missed[0];
    alerts.push({
      id: "missed_signal",
      severity: "warning",
      title: `${missed.length} signal${missed.length === 1 ? "" : "s"} not executed (last 2h)`,
      detail: `Most recent: ${latest.pair} ${latest.tier.replace("_", " ")} ${minutesAgo(latest.createdAt, now)}${
        latest.wasRejected ? " — reached the broker but was rejected." : " — never reached an execution attempt (a gate, sizing, or the connection blocked it)."
      }`,
    });
  }

  const severityRank: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
  const highest = alerts.reduce<Severity | null>(
    (acc, a) => (acc === null || severityRank[a.severity] > severityRank[acc] ? a.severity : acc),
    null
  );

  return Response.json({ generatedAt: now, count: alerts.length, highestSeverity: highest, alerts });
}
