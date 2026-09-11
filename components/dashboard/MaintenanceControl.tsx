"use client";

import { useState } from "react";

interface RepairAction {
  type: "reconnect" | "refresh_market_data";
  account?: string;
  pair?: string;
  timeframe?: string;
}
interface CheckItem {
  label: string;
  status: "pass" | "warning" | "fail" | "not_configured";
  detail: string;
  repair?: RepairAction;
}
interface MaintenanceSection {
  name: string;
  healthPct: number;
  items: CheckItem[];
}
interface MaintenanceReport {
  generatedAt: number;
  overallHealthPct: number;
  sections: MaintenanceSection[];
  last24h: { totalEvaluated: number; qualified: number; rejected: number; topBlockers: { reasonCode: string; count: number }[] };
  recentExecutionErrors: { reason: string; count: number }[];
  problemsFound: number;
  safeRepairsAvailable: number;
  manualApprovalRequired: number;
  criticalIssues: number;
  availableRepairs: { section: string; label: string; action: RepairAction }[];
  lastQualifiedSignal: {
    pair: string;
    source: string;
    tier: string;
    confidence: number;
    createdAt: number;
    outcome: "executed" | "rejected" | "not_executed";
    outcomeDetail: string;
  } | null;
  autoExecutionActivity: {
    signalsSeen: number;
    lastSignalSeenAt: number | null;
    lastSignalSeen: { pair: string; tier: string; source: string } | null;
    attemptsTotal: number;
    filledTotal: number;
    recentAttempts: { pair: string; tier: string; source: string; direction: string; account: string | null; result: string; at: number }[];
  };
}
interface RepairOutcome {
  label: string;
  applied: boolean;
  success: boolean;
  message: string;
}

const STATUS_STYLE: Record<CheckItem["status"], { icon: string; color: string }> = {
  pass: { icon: "✓", color: "text-emerald-400" },
  warning: { icon: "⚠", color: "text-amber-400" },
  fail: { icon: "✗", color: "text-rose-400" },
  not_configured: { icon: "–", color: "text-zinc-500" },
};

function healthColor(pct: number): string {
  if (pct >= 90) return "text-emerald-400";
  if (pct >= 70) return "text-amber-400";
  return "text-rose-400";
}

function healthBadge(pct: number): string {
  if (pct >= 90) return "🟢 HEALTHY";
  if (pct >= 70) return "🟡 WARNING";
  return "🔴 CRITICAL";
}

/**
 * A permanent, on-demand health check (operator request, 2026-09-09) with a real Safe
 * Repair mode (added 2026-09-10). SCAN reads real state and never changes anything.
 * "Apply Safe Repairs" applies only the two repair kinds this codebase can genuinely do
 * without any risk (reconnect, refresh stale market data -- see maintenanceCheck.ts's
 * own doc comment for why nothing else qualifies) -- every other problem the scan finds
 * is a deliberate safety state with its own dedicated control elsewhere in this app, and
 * is deliberately NOT duplicated here. Mirrors forex-ai-mobile's MaintenanceControl.tsx.
 */
export function MaintenanceControl() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairResults, setRepairResults] = useState<RepairOutcome[]>([]);

  async function runScan() {
    setOpen(true);
    setBusy(true);
    setError(null);
    setRepairResults([]);
    try {
      const res = await fetch("/api/maintenance");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setReport((await res.json()) as MaintenanceReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function applySafeRepairs() {
    if (!report) return;
    setRepairing(true);
    setRepairResults([]);
    const results: RepairOutcome[] = [];
    for (const repair of report.availableRepairs) {
      try {
        const res = await fetch("/api/maintenance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: repair.action }),
        });
        const outcome = (await res.json()) as RepairOutcome;
        results.push(outcome);
      } catch {
        results.push({ label: repair.label, applied: false, success: false, message: "Network error" });
      }
      setRepairResults([...results]);
    }
    setRepairing(false);
    // Re-scan so the sections/summary above reflect what was just repaired.
    await runScan();
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={runScan}
        className="w-fit rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-700"
      >
        🔧 Autopilot Maintenance
      </button>

      {open && (
        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-zinc-900/80 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-zinc-100">Autopilot Maintenance</p>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-300">
              Close
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Scan reads real system state and changes nothing. Safe Repair only ever reconnects a dropped connection or refreshes stale market
            data -- both already run automatically in this app; this just lets you trigger them right now instead of waiting.
          </p>

          {busy && <p className="text-xs text-zinc-400">Running scan…</p>}
          {error && <p className="text-xs text-rose-400">{error}</p>}

          {report && !busy && (
            <>
              <div className="flex items-center justify-between rounded-lg bg-zinc-800/60 px-3 py-2">
                <span className="text-xs font-semibold text-zinc-400">OVERALL HEALTH</span>
                <span className={`text-lg font-extrabold ${healthColor(report.overallHealthPct)}`}>
                  {report.overallHealthPct}% {healthBadge(report.overallHealthPct)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-800/40 p-2.5 text-[11px] sm:grid-cols-4">
                <div className="flex flex-col">
                  <span className="text-zinc-500">Problems found</span>
                  <span className="text-sm font-bold text-zinc-100">{report.problemsFound}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-zinc-500">Safe repairs available</span>
                  <span className="text-sm font-bold text-sky-400">{report.safeRepairsAvailable}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-zinc-500">Manual approval needed</span>
                  <span className="text-sm font-bold text-amber-400">{report.manualApprovalRequired}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-zinc-500">Critical issues</span>
                  <span className="text-sm font-bold text-rose-400">{report.criticalIssues}</span>
                </div>
              </div>

              {report.safeRepairsAvailable > 0 && (
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={applySafeRepairs}
                    disabled={repairing}
                    className="w-fit rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {repairing ? "Applying…" : `Apply Safe Repairs (${report.availableRepairs.length})`}
                  </button>
                  {report.availableRepairs.map((r) => (
                    <p key={`${r.section}-${r.label}`} className="text-[11px] text-zinc-500">
                      • {r.label} ({r.section})
                    </p>
                  ))}
                </div>
              )}

              {repairResults.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg border border-white/5 p-2.5">
                  <span className="text-xs font-bold uppercase tracking-wide text-zinc-400">Repair Results</span>
                  {repairResults.map((r) => (
                    <p key={r.label} className={`text-[11px] ${r.success ? "text-emerald-400" : "text-rose-400"}`}>
                      {r.success ? "✓" : "✗"} {r.label}: {r.message}
                    </p>
                  ))}
                </div>
              )}

              {report.sections.map((section) => (
                <div key={section.name} className="flex flex-col gap-1.5 rounded-lg border border-white/5 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wide text-zinc-400">{section.name}</span>
                    <span className={`text-xs font-bold ${healthColor(section.healthPct)}`}>{section.healthPct}%</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {section.items.map((item) => (
                      <div key={item.label} className="flex items-start gap-2 text-[11px]">
                        <span className={STATUS_STYLE[item.status].color}>{STATUS_STYLE[item.status].icon}</span>
                        <span className="font-semibold text-zinc-300">{item.label}:</span>
                        <span className="text-zinc-500">{item.detail}</span>
                        {item.status !== "pass" && item.status !== "not_configured" && (
                          <span className={item.repair ? "text-sky-500" : "text-zinc-600"}>
                            {item.repair ? "(safe repair available)" : "(needs your own review)"}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex flex-col gap-1 rounded-lg border border-white/5 p-2.5">
                <span className="text-xs font-bold uppercase tracking-wide text-zinc-400">Last Qualified Signal</span>
                {report.lastQualifiedSignal ? (
                  <>
                    <p className="text-[11px] text-zinc-300">
                      {report.lastQualifiedSignal.pair} · {report.lastQualifiedSignal.source} · {report.lastQualifiedSignal.tier} ·{" "}
                      {report.lastQualifiedSignal.confidence}% · {new Date(report.lastQualifiedSignal.createdAt).toLocaleString()}
                    </p>
                    <p
                      className={`text-[11px] font-semibold ${
                        report.lastQualifiedSignal.outcome === "executed"
                          ? "text-emerald-400"
                          : report.lastQualifiedSignal.outcome === "rejected"
                            ? "text-rose-400"
                            : "text-amber-400"
                      }`}
                    >
                      {report.lastQualifiedSignal.outcome.replace("_", " ").toUpperCase()} — {report.lastQualifiedSignal.outcomeDetail}
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] text-zinc-500">No buy/strong-buy signal in the recent window yet.</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5 rounded-lg border border-white/5 p-2.5">
                <span className="text-xs font-bold uppercase tracking-wide text-zinc-400">Auto-Execution Activity (since boot)</span>
                <p className="text-[11px] text-zinc-300">
                  {report.autoExecutionActivity.signalsSeen} signal{report.autoExecutionActivity.signalsSeen === 1 ? "" : "s"} reached the
                  listener · {report.autoExecutionActivity.attemptsTotal} attempt{report.autoExecutionActivity.attemptsTotal === 1 ? "" : "s"} ·{" "}
                  {report.autoExecutionActivity.filledTotal} filled
                </p>
                {report.autoExecutionActivity.recentAttempts.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">No execution attempts yet since restart.</p>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {report.autoExecutionActivity.recentAttempts.slice(0, 5).map((a, i) => (
                      <p key={i} className="text-[11px] text-zinc-400">
                        <span className={a.result === "filled" ? "font-semibold text-emerald-400" : "text-zinc-300"}>{a.result}</span> —{" "}
                        {a.pair} {a.tier} ({a.source}) {a.direction} · {new Date(a.at).toLocaleTimeString()}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5 rounded-lg border border-white/5 p-2.5">
                <span className="text-xs font-bold uppercase tracking-wide text-zinc-400">Why No Trade -- Last 24 Hours</span>
                <p className="text-[11px] text-zinc-400">
                  Evaluated {report.last24h.totalEvaluated.toLocaleString()} times -- {report.last24h.qualified} qualified,{" "}
                  {report.last24h.rejected.toLocaleString()} rejected.
                </p>
                {report.last24h.topBlockers.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] font-semibold text-zinc-400">Top blockers:</span>
                    {report.last24h.topBlockers.map((b) => (
                      <span key={b.reasonCode} className="text-[11px] text-zinc-500">
                        {b.reasonCode}: {b.count.toLocaleString()}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {report.recentExecutionErrors.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-white/5 p-2.5">
                  <span className="text-xs font-bold uppercase tracking-wide text-zinc-400">Execution Errors -- Last 24 Hours</span>
                  {report.recentExecutionErrors.map((e) => (
                    <span key={e.reason} className="text-[11px] text-rose-400">
                      {e.count}x: {e.reason}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-[10px] text-zinc-600">Generated {new Date(report.generatedAt).toLocaleString()}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
