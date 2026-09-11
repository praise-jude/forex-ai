import { PAIRS, type AccountKey, type Pair, type Timeframe } from "./types";
import { isKillSwitchActive } from "./riskManager";
import { getEngineMode } from "./engineMode";
import { isAutopilotLocked } from "./autopilotLock";
import { requiresAcknowledgement, riskState } from "./riskState";
import {
  forceReconnect,
  getAccountInformation,
  getConnectionStatus,
  isAccountConfigured,
  isPairTimeframeStale,
  repairStaleMarketData,
  SIGNAL_TIMEFRAMES,
} from "./metaApiConnection";
import { loadExecutionConfig } from "./executionConfig";
import { getEvaluationSummary, getLastEvaluationAt } from "./evaluationLog";
import { positionStore } from "./positionStore";
import { signalStore } from "./signalStore";
import { getExecutionPolicy } from "./executionPolicy";
import { getOptionalDb } from "../db/optionalClient";
import { getAutoExecutionActivity } from "./autoExecutionActivity";

/**
 * A real, read-only health scan across every real gate/subsystem this app already has --
 * built by consolidating the exact manual checks run tonight (2026-09-09) into one
 * permanent feature (operator request: "a permanent maintenance button... to run a
 * complete Auto Pilot health check from time to time").
 *
 * Mode 1 (Scan) never mutates anything -- reads real state, reports it. Mode 2 (Safe
 * Repair, added 2026-09-10) is deliberately narrow: this codebase only has TWO actions
 * that are genuinely safe to auto-apply without risking anything --
 *  - reconnect: forceReconnect(), the exact same function connectionWatchdog.ts already
 *    calls automatically in production once a connection has been unhealthy long enough.
 *    Non-destructive by construction -- it closes and rebuilds a connection object, never
 *    touches an open position or any configuration.
 *  - refresh_market_data: repairStaleMarketData(), the same REST refresh the periodic
 *    stale-data safety net already runs automatically. Purely additive (fetches and
 *    upserts fresh candles) -- can never make data worse or lose anything.
 * Neither one needs a snapshot or a rollback control: both are idempotent, already
 * proven in production, and structurally incapable of leaving the system in a worse
 * state than before (a failed reconnect attempt just means "still disconnected", not
 * "newly broken"; a failed refresh just means "still stale", not "corrupted"). Building
 * a full snapshot/rollback system for these two would be ceremony without substance.
 *
 * Everything else the scan flags (kill switch, engine mode, autopilot lock, risk
 * acknowledgement, an engine toggled off) is a deliberate safety state, not a technical
 * fault -- each already has its own dedicated, single-click control elsewhere in this
 * app (EngineModeControl, AutopilotLockControl, the risk-guardian "Resume trading"
 * banner, EngineTogglesControl). Maintenance deliberately does NOT offer a second,
 * parallel way to flip any of those -- that would just be a confusing duplicate of a
 * control that already exists and is already the right place to make that call.
 */
export type CheckStatus = "pass" | "warning" | "fail" | "not_configured";

export type RepairAction = { type: "reconnect"; account: AccountKey } | { type: "refresh_market_data"; pair: Pair; timeframe: Timeframe };

export interface CheckItem {
  label: string;
  status: CheckStatus;
  detail: string;
  /** Present only when this specific failing item has a real, safe, automatic repair
   * available (see this module's own doc comment for the narrow set of what qualifies). */
  repair?: RepairAction;
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
  /** Real counts over every item across every section -- see this module's own doc
   * comment for exactly which problems get a `repair` action (safeRepairsAvailable) vs
   * which are deliberate safety states that only your own dedicated control should
   * touch (manualApprovalRequired = problemsFound - safeRepairsAvailable). */
  problemsFound: number;
  safeRepairsAvailable: number;
  manualApprovalRequired: number;
  /** "fail" items specifically -- a genuine technical fault, distinct from "warning"
   * (a deliberate, intentional safety state like the kill switch or a locked autopilot,
   * which isn't broken, just worth surfacing). */
  criticalIssues: number;
  /** Every currently-available safe repair, flattened across sections -- the "Apply Safe
   * Repairs" button applies each of these in turn. Empty when there's nothing to repair. */
  availableRepairs: { section: string; label: string; action: RepairAction }[];
  /** The single most recent buy/strong_buy signal from any engine, and what became of it
   * -- the direct "did anything real fire, and did it actually execute" answer that
   * otherwise takes a manual DB dig every time. Null when no qualifying signal exists in
   * the in-memory signal store's window at all. */
  lastQualifiedSignal: {
    pair: string;
    source: string;
    tier: string;
    confidence: number;
    createdAt: number;
    outcome: "executed" | "rejected" | "not_executed";
    outcomeDetail: string;
  } | null;
  /** The direct, permanent answer to "is the autopilot even receiving signals, and what
   * happens to them" -- see autoExecutionActivity.ts's own doc comment for the incident
   * (2026-09-11) that made a manual database query the only way to answer this. */
  autoExecutionActivity: {
    signalsSeen: number;
    lastSignalSeenAt: number | null;
    lastSignalSeen: { pair: string; tier: string; source: string } | null;
    attemptsTotal: number;
    filledTotal: number;
    recentAttempts: { pair: string; tier: string; source: string; direction: string; account: string | null; result: string; at: number }[];
  };
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

  const policy = getExecutionPolicy();
  items.push({
    label: "Auto-execute floor",
    status: "pass",
    detail:
      policy.minTier === "strong_buy"
        ? "Strong buy only -- 'buy'-tier signals are held, not auto-executed"
        : `Buy or higher${policy.minRiskReward > 0 ? `, R:R >= ${policy.minRiskReward}` : ""}`,
  });

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

/** The check that would have made the last two days obvious at a glance: an account with
 * no equity can't size a trade at all (riskAmount = equity * riskPct = 0 -> zero lots ->
 * skipped_sizing), so every qualifying signal silently goes nowhere no matter how healthy
 * everything else is. */
async function checkFunding(accountKey: AccountKey): Promise<MaintenanceSection> {
  const items: CheckItem[] = [];
  const account = getAccountInformation(accountKey);
  if (!account) {
    items.push({ label: "Account", status: "fail", detail: "No account information available yet -- the connection may still be syncing." });
    return { name: "Funding", healthPct: sectionHealth(items), items };
  }

  items.push({
    label: "Equity",
    status: account.equity > 0 ? "pass" : "fail",
    detail:
      account.equity > 0
        ? `$${account.equity.toFixed(2)} -- enough to size a trade`
        : "$0.00 -- position sizing returns zero lots, so no signal can execute regardless of how good it is",
  });
  items.push({
    label: "Free margin",
    status: account.freeMargin > 0 ? "pass" : "warning",
    detail: `$${account.freeMargin.toFixed(2)} available`,
  });
  items.push({
    label: "Broker trade permission",
    status: account.tradeAllowed ? "pass" : "fail",
    detail: account.tradeAllowed ? "Trading allowed on this account" : "The broker is currently NOT allowing trades on this account",
  });

  return { name: "Funding", healthPct: sectionHealth(items), items };
}

/** Section 17 of the operator's own spec -- a heartbeat on the analysis loop itself.
 * This app has a real history of the SDK-level resync loop silently freezing signal
 * evaluation while the connection still reads "live"; evaluationLog.ts already tracks the
 * last completed evaluation for its own periodic alert, this just surfaces it on demand. */
function checkEngineHealth(): MaintenanceSection {
  const items: CheckItem[] = [];
  const lastEval = getLastEvaluationAt();
  const STALL_MS = 25 * 60 * 1000;
  if (lastEval === null) {
    items.push({ label: "Analysis loop", status: "warning", detail: "No evaluation has completed yet since the last restart -- may still be warming up." });
  } else {
    const ageMin = Math.round((Date.now() - lastEval) / 60000);
    items.push({
      label: "Analysis loop",
      status: Date.now() - lastEval > STALL_MS ? "fail" : "pass",
      detail:
        Date.now() - lastEval > STALL_MS
          ? `Last completed evaluation was ${ageMin} min ago -- normally one completes every ~15 min. The signal engine may be stuck.`
          : `Last completed evaluation ${ageMin} min ago -- healthy (one is expected roughly every 15 min).`,
    });
  }
  return { name: "Engine Health", healthPct: sectionHealth(items), items };
}

function minutesAgo(at: number, now: number): string {
  const min = Math.round((now - at) / 60000);
  return min < 1 ? "just now" : min === 1 ? "1 min ago" : `${min} min ago`;
}

/** The permanent fix for a real incident (2026-09-11): the operator had no way to tell
 * whether the autopilot had EVER actually auto-fired a trade, short of a manual
 * database query proving it via a millisecond-scale timestamp gap. Reads
 * autoExecutionActivity.ts's in-memory trail -- see that module's own doc comment. */
function checkAutoExecutionActivity(): MaintenanceSection {
  const items: CheckItem[] = [];
  const activity = getAutoExecutionActivity();
  const now = Date.now();

  if (activity.signalsSeen === 0) {
    items.push({
      label: "Signals reaching auto-execution",
      status: "warning",
      detail: "No signal has reached the auto-execution listener yet since the last restart -- may just be waiting for one, or the listener isn't wired up. Give it time before treating this as broken.",
    });
  } else {
    const last = activity.lastSignalSeen;
    items.push({
      label: "Signals reaching auto-execution",
      status: "pass",
      detail: `${activity.signalsSeen} seen since boot -- last: ${last?.pair} ${last?.tier} (${last?.source}) ${activity.lastSignalSeenAt ? minutesAgo(activity.lastSignalSeenAt, now) : ""}`,
    });
  }

  if (activity.attemptsTotal > 0) {
    const last = activity.recentAttempts[0];
    items.push({
      label: "Execution attempts",
      status: "pass",
      detail: `${activity.attemptsTotal} attempted, ${activity.filledTotal} filled since boot -- last: ${last.pair} ${last.result} ${minutesAgo(last.at, now)}`,
    });
  } else if (activity.signalsSeen > 0) {
    items.push({
      label: "Execution attempts",
      status: "warning",
      detail: `${activity.signalsSeen} signal(s) reached the listener but none led to an execution attempt -- every one was stopped by an early gate (engine mode, autopilot lock, disabled engine, or risk acknowledgement). Check Autopilot Core.`,
    });
  } else {
    items.push({ label: "Execution attempts", status: "not_configured", detail: "No signals seen yet since restart, so nothing to attempt." });
  }

  return { name: "Auto-Execution Activity", healthPct: sectionHealth(items), items };
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
        repair: stale ? { type: "refresh_market_data", pair, timeframe } : undefined,
      });
    }
  }
  return { name: "Market Data", healthPct: sectionHealth(items), items };
}

async function checkConnection(): Promise<MaintenanceSection> {
  const items: CheckItem[] = [];
  const live = getConnectionStatus("live");
  items.push({
    label: "Live connection",
    status: live.status === "live" ? "pass" : live.status === "reconnecting" ? "warning" : "fail",
    detail: live.status,
    repair: live.status !== "live" ? { type: "reconnect", account: "live" } : undefined,
  });

  if (isAccountConfigured("demo")) {
    const demo = getConnectionStatus("demo");
    items.push({
      label: "Demo connection",
      status: demo.status === "live" ? "pass" : demo.status === "reconnecting" ? "warning" : "fail",
      detail: demo.status,
      repair: demo.status !== "live" ? { type: "reconnect", account: "demo" } : undefined,
    });
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

/** "Did anything real fire, and did it actually execute" -- the exact question that
 * otherwise takes a manual DB dig. Reads the in-memory stores only (both hydrated at
 * boot), no new query. */
function getLastQualifiedSignal(accountKey: AccountKey): MaintenanceReport["lastQualifiedSignal"] {
  const qualified = signalStore
    .all()
    .filter((s) => (s.source === "smc" || s.source === "mean_reversion" || s.source === "trend_continuation") && (s.tier === "buy" || s.tier === "strong_buy"))
    .sort((a, b) => b.createdAt - a.createdAt);
  const signal = qualified[0];
  if (!signal) return null;

  const trade = positionStore.all().find((t) => t.signalId === signal.id && t.account === accountKey);
  let outcome: "executed" | "rejected" | "not_executed";
  let outcomeDetail: string;
  if (trade?.status === "filled") {
    outcome = "executed";
    outcomeDetail = `Auto-executed at ${trade.filledEntry ?? trade.requestedEntry}.`;
  } else if (trade?.status === "rejected") {
    outcome = "rejected";
    outcomeDetail = `Reached the broker but was rejected: ${trade.rejectReason ?? "unknown reason"}.`;
  } else {
    outcome = "not_executed";
    outcomeDetail =
      "Never reached an execution attempt -- most often means it fired while Engine Mode wasn't LIVE, the account had no equity to size it, or a risk gate blocked it before the broker call (which leaves no trade record).";
  }

  return { pair: signal.pair, source: signal.source, tier: signal.tier, confidence: signal.confidence, createdAt: signal.createdAt, outcome, outcomeDetail };
}

/** The one Mode 1 entry point -- runs every section, never mutates anything. */
export async function runMaintenanceScan(accountKey: AccountKey = "live"): Promise<MaintenanceReport> {
  const [core, funding, engineHealth, autoExecActivitySection, marketData, connection, storage, last24h] = await Promise.all([
    checkAutopilotCore(accountKey),
    checkFunding(accountKey),
    Promise.resolve(checkEngineHealth()),
    Promise.resolve(checkAutoExecutionActivity()),
    checkMarketData(),
    checkConnection(),
    checkStorage(),
    getEvaluationSummary(Date.now() - 24 * 60 * 60 * 1000),
  ]);

  const sections = [core, funding, engineHealth, autoExecActivitySection, marketData, connection, storage];
  const overallHealthPct = Math.round(sections.reduce((sum, s) => sum + s.healthPct, 0) / sections.length);

  const allItems = sections.flatMap((s) => s.items.map((item) => ({ section: s.name, item })));
  const problems = allItems.filter(({ item }) => item.status === "warning" || item.status === "fail");
  const availableRepairs = problems
    .filter(({ item }) => item.repair !== undefined)
    .map(({ section, item }) => ({ section, label: item.label, action: item.repair as RepairAction }));

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
    problemsFound: problems.length,
    safeRepairsAvailable: availableRepairs.length,
    manualApprovalRequired: problems.length - availableRepairs.length,
    criticalIssues: allItems.filter(({ item }) => item.status === "fail").length,
    availableRepairs,
    lastQualifiedSignal: getLastQualifiedSignal(accountKey),
    autoExecutionActivity: getAutoExecutionActivity(),
  };
}

export interface RepairOutcome {
  label: string;
  /** False when the scan's own finding had already resolved itself by the time this ran
   * (e.g. the connection recovered on its own between the scan and clicking "Apply") --
   * in that case nothing is actually touched, "applied" stays false, and this is reported
   * as a genuine success rather than a repair that had nothing real to do. */
  applied: boolean;
  success: boolean;
  message: string;
}

/**
 * Mode 2 -- applies exactly ONE of the two safe repair kinds this module recognizes (see
 * its own doc comment for why nothing else is offered here). Re-verifies the underlying
 * problem is still real immediately before acting (never blindly repeats a stale scan's
 * finding) and re-checks afterward so the caller gets a genuine, verified before/after
 * answer -- never just "we tried".
 */
export async function applyRepair(action: RepairAction, accountKey: AccountKey = "live"): Promise<RepairOutcome> {
  if (action.type === "reconnect") {
    const label = `Reconnect (${action.account})`;
    if (getConnectionStatus(action.account).status === "live") {
      return { label, applied: false, success: true, message: "Already connected -- nothing to repair." };
    }
    try {
      await forceReconnect(action.account);
    } catch (error) {
      return { label, applied: true, success: false, message: error instanceof Error ? error.message : String(error) };
    }
    const after = getConnectionStatus(action.account).status;
    return { label, applied: true, success: after === "live", message: after === "live" ? "Reconnected successfully." : `Still ${after} after the reconnect attempt.` };
  }

  const label = `Refresh ${action.pair} ${action.timeframe}`;
  if (!isPairTimeframeStale(action.pair, action.timeframe)) {
    return { label, applied: false, success: true, message: "Already fresh -- nothing to repair." };
  }
  const result = await repairStaleMarketData(action.pair, action.timeframe, accountKey);
  return {
    label,
    applied: true,
    success: result.success,
    message: result.success ? "Refreshed successfully -- fresh data confirmed." : "Refresh attempted, but the data is still stale (the broker connection may be unavailable right now).",
  };
}
