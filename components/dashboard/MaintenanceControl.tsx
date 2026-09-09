"use client";

import { useState } from "react";

interface CheckItem {
  label: string;
  status: "pass" | "warning" | "fail" | "not_configured";
  detail: string;
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
 * A permanent, on-demand health check (operator request, 2026-09-09) -- consolidates
 * every real gate/subsystem check this session verified manually into one button.
 * SCAN ONLY: this never changes anything, only reads and reports real state (see
 * maintenanceCheck.ts's own doc comment for why repair/rollback automation is
 * deliberately out of scope for this first pass). Mirrors forex-ai-mobile's
 * MaintenanceControl.tsx.
 */
export function MaintenanceControl() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runScan() {
    setOpen(true);
    setBusy(true);
    setError(null);
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
            Scan only -- reads real system state, changes nothing. Re-run any time you suspect something is broken.
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
                      </div>
                    ))}
                  </div>
                </div>
              ))}

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
