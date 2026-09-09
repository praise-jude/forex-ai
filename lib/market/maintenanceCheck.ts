import { PAIRS, type AccountKey } from "./types";
import { isKillSwitchActive } from "./riskManager";
import { getEngineMode } from "./engineMode";
import { isAutopilotLocked } from "./autopilotLock";
import { requiresAcknowledgement, riskState } from "./riskState";
import { getAccountInformation, getConnectionStatus, isAccountConfigured, isPairTimeframeStale, SIGNAL_TIMEFRAMES } from "./metaApiConnection";
import { loadExecutionConfig } from "./executionConfig";
import { getEvaluationSummary } from "./evaluationLog";
import { positionStore } from "./positionStore";
import { getOptionalDb } from "../db/optionalClient";

/**
 * A real, read-only health scan across every real gate/subsystem this app already has --
 * built by consolidating the exact manual checks run tonight (2026-09-09) into one
 * permanent feature (operator request: "a permanent maintenance button... to run a
 * complete Auto Pilot health check from time to time").
 *
 * SCAN ONLY -- this module changes nothing. It reads real state and reports it; nothing
 * here mutates configuration, restarts anything, or touches trading behavior in any way.
 * The auto-repair/snapshot/rollback machinery the operator's own fuller spec describes is
 * deliberately NOT part of this first pass -- that's real, separate infrastructure
 * (safe-repair classification, config snapshots, a reversible rollback system) that
 * deserves its own careful design, not something bolted onto a scan-only feature in the
 * same sitting. This gives the real, honest "what's broken and why" the operator asked
 * for; repair automation is future work, explicitly deferred, not silently skipped.
 */
export type CheckStatus = "pass" | "warning" | "fail" | "not_configured";

export interface CheckItem {
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface MaintenanceSection {
  name: string;
  healthPct: number;
  items: CheckItem[];
}

export interface MaintenanceReport {
  generatedAt: number;
  overallHealthPct: number;
  sections: MaintenanceSection[];
  last24h: {
    totalEvaluated: number;
    qualified: number;
    rejected: number;
    topBlockers: { reasonCode: string; count: number }[];
  };
  recentExecutionErrors: { reason: string; count: number }[];
}

export function sectionHealth(items: CheckItem[]): number {
  if (items.length === 0) return 100;
  // "warning" counts as half-credit -- a real, honest middle ground between "this gate
  // is fine" and "this gate is actually broken", not rounded up or down to either extreme.
  const weight = (status: CheckStatus) => (status === "pass" ? 1 : status === "warning" ? 0.5 : status === "not_configured" ? 1 : 0);
  const total = items.reduce((sum, item) => sum + weight(item.status), 0);
  return Math.round((total / items.length) * 100);
}

async function checkAutopilotCore(accountKey: AccountKey): Promise<MaintenanceSection> {
  const items: CheckItem[] = [];
  const config = loadExecutionConfig(accountKey);

  const killSwitch = isKillSwitchActive(config.killSwitchFile);
  items.push({ label: "Kill switch", status: killSwitch ? "warning" : "pass", detail: killSwitch ? "Active -- no new trades of any kind" : "Off" });

  const mode = getEngineMode();
  items.push({
    label: "Engine mode",
    status: mode === "live" || mode === "demo" ? "pass" : "warning",
    detail: mode === "analysis" ? "ANALYSIS -- auto-execution is a no-op until switched to DEMO/LIVE" : mode.toUpperCase(),
  });

  const locked = isAutopilotLocked();
  items.push({ label: "Autopilot lock", status: locked ? "warning" : "pass", detail: locked ? "Locked -- autoExecutionListener will not open new trades" : "Unlocked" });

  const account = getAccountInformation(accountKey);
  const equity = account?.equity ?? 0;
  const dayState = riskState.current(Date.now(), equity, accountKey);
  const needsAck = requiresAcknowledgement(dayState);
  items.push({
    label: "Risk acknowledgement",
    status: needsAck ? "warning" : "pass",
    detail: needsAck ? "A halt/cooldown is awaiting operator review -- auto-execution stays blocked until acknowledged" : "Clear",
  });

  items.push({
    label: "Range Engine",
    status: config.rangeEngineEnabled ? "pass" : "not_configured",
    detail: config.rangeEngineEnabled ? "Enabled" : "Disabled -- range_below_threshold/mean_reversion signals will never auto-execute",
  });
  items.push({
    label: "Trend Continuation",
    status: config.trendContinuationEnabled ? "pass" : "not_configured",
    detail: config.trendContinuationEnabled ? "Enabled" : "Disabled -- trend_continuation signals will never auto-execute",
  });

  return { name: "Autopilot Core", healthPct: sectionHealth(items), items };
}

async function checkMarketData(): Promise<MaintenanceSection> {
  const items: CheckItem[] = [];
  for (const pair of PAIRS) {
    for (const timeframe of SIGNAL_TIMEFRAMES) {
      const stale = isPairTimeframeStale(pair, timeframe);
      items.push({
        label: `${pair} ${timeframe}`,
        status: stale ? "fail" : "pass",
        detail: stale ? "Stale -- last closed candle is older than 2x this timeframe's own bar interval" : "Fresh",
      });
    }
  }
  return { name: "Market Data", healthPct: sectionHealth(items), items };
}

async function checkConnection(): Promise<MaintenanceSection> {
  const items: CheckItem[] = [];
  const live = getConnectionStatus("live");
  items.push({ label: "Live connection", status: live.status === "live" ? "pass" : live.status === "reconnecting" ? "warning" : "fail", detail: live.status });

  if (isAccountConfigured("demo")) {
    const demo = getConnectionStatus("demo");
    items.push({ label: "Demo connection", status: demo.status === "live" ? "pass" : demo.status === "reconnecting" ? "warning" : "fail", detail: demo.status });
  } else {
    items.push({ label: "Demo connection", status: "not_configured", detail: "No demo account configured -- use the dry-run test instead" });
  }

  return { name: "Connection", healthPct: sectionHealth(items), items };
}

async function checkStorage(): Promise<MaintenanceSection> {
  const items: CheckItem[] = [];
  const db = getOptionalDb();
  if (!db) {
    items.push({ label: "Database", status: "not_configured", detail: "DATABASE_URL not set -- signal/execution history will not persist across restarts" });
  } else {
    try {
      await db.execute("select 1");
      items.push({ label: "Database", status: "pass", detail: "Reachable" });
    } catch (error) {
      items.push({ label: "Database", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { name: "Storage", healthPct: sectionHealth(items), items };
}

function checkExecutionErrors(accountKey: AccountKey): { reason: string; count: number }[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rejected = positionStore.all().filter((t) => t.account === accountKey && t.status === "rejected" && t.attemptedAt >= cutoff);
  const grouped = new Map<string, number>();
  for (const trade of rejected) {
    const reason = trade.rejectReason ?? "unknown";
    grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
  }
  return Array.from(grouped.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/** The one entry point -- runs every section, never mutates anything. */
export async function runMaintenanceScan(accountKey: AccountKey = "live"): Promise<MaintenanceReport> {
  const [core, marketData, connection, storage, last24h] = await Promise.all([
    checkAutopilotCore(accountKey),
    checkMarketData(),
    checkConnection(),
    checkStorage(),
    getEvaluationSummary(Date.now() - 24 * 60 * 60 * 1000),
  ]);

  const sections = [core, marketData, connection, storage];
  const overallHealthPct = Math.round(sections.reduce((sum, s) => sum + s.healthPct, 0) / sections.length);

  return {
    generatedAt: Date.now(),
    overallHealthPct,
    sections,
    last24h: {
      totalEvaluated: last24h.totalEvaluated,
      qualified: last24h.qualified,
      rejected: last24h.rejected,
      topBlockers: last24h.topBlockers,
    },
    recentExecutionErrors: checkExecutionErrors(accountKey),
  };
}
