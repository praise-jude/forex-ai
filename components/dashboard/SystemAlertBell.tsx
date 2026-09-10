"use client";

import { useEffect, useRef, useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

type Severity = "critical" | "warning" | "info";

interface SystemAlert {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

interface SystemAlertsResponse {
  generatedAt: number;
  count: number;
  highestSeverity: Severity | null;
  alerts: SystemAlert[];
}

const POLL_INTERVAL_MS = 5000;

const BELL_TONE: Record<Severity, string> = {
  critical: "border-rose-700 bg-rose-950/50 text-rose-300",
  warning: "border-amber-700 bg-amber-950/40 text-amber-300",
  info: "border-sky-800 bg-sky-950/40 text-sky-300",
};

const DOT_TONE: Record<Severity, string> = {
  critical: "bg-rose-500",
  warning: "bg-amber-400",
  info: "bg-sky-400",
};

const ROW_TONE: Record<Severity, string> = {
  critical: "border-l-rose-500",
  warning: "border-l-amber-400",
  info: "border-l-sky-400",
};

async function fetchAlerts(): Promise<SystemAlertsResponse> {
  const res = await fetch("/api/system-alerts");
  return res.json();
}

export function SystemAlertBell() {
  const { data } = usePolledResource<SystemAlertsResponse>("system-alerts", fetchAlerts, POLL_INTERVAL_MS);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const alerts = data?.alerts ?? [];
  const count = alerts.length;
  const severity = data?.highestSeverity ?? null;

  // Dim + quiet when everything is healthy; toned + badged when not. Never hidden
  // entirely -- a persistent "all clear" affordance is the point (the operator can open
  // it any time to confirm nothing's wrong), matching ConnectionStatus always rendering.
  const toneClass = severity ? BELL_TONE[severity] : "border-white/10 bg-zinc-800 text-zinc-400";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={count > 0 ? `${count} system alert${count === 1 ? "" : "s"}` : "System status: all clear"}
        aria-expanded={open}
        className={`relative flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition ${toneClass} ${
          severity === "critical" ? "animate-pulse" : ""
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5c0 3.5-1.2 4.9-1.8 5.6-.3.3-.1.9.4.9h11.8c.5 0 .7-.6.4-.9-.6-.7-1.8-2.1-1.8-5.6A4.5 4.5 0 0 0 10 2.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M8.5 16.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">{count > 0 ? `${count} alert${count === 1 ? "" : "s"}` : "All clear"}</span>
        {count > 0 && (
          <span className={`ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-zinc-950 ${
            severity ? DOT_TONE[severity] : "bg-zinc-400"
          }`}>
            {count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[min(92vw,20rem)] overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
          <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300">
            System status
          </div>
          {count === 0 ? (
            <p className="px-3 py-3 text-xs text-zinc-400">
              All clear — auto-trading, the MT5 connection, execution, and risk checks are healthy.
            </p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-white/5 overflow-y-auto">
              {alerts.map((alert) => (
                <li key={alert.id} className={`border-l-2 px-3 py-2.5 ${ROW_TONE[alert.severity]}`}>
                  <p className="text-xs font-semibold text-zinc-100">{alert.title}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">{alert.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
