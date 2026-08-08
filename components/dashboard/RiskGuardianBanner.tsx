"use client";

import { useEffect, useState } from "react";

interface RiskStatusResponse {
  account: "live" | "demo";
  haltedForToday: boolean;
  cooldownUntil: number | null;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  maxDailyLossPct: number;
}

const POLL_INTERVAL_MS = 7000;

function formatRemaining(cooldownUntil: number, now: number): string {
  const totalSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Renders nothing when nothing is active -- this is a guardian-tripped alert, not a
 * status-quo indicator (ConnectionStatus/EngineModeControl already cover normal state). */
export function RiskGuardianBanner() {
  const [data, setData] = useState<RiskStatusResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    function poll() {
      fetch("/api/risk-status")
        .then((res) => res.json())
        .then((json: RiskStatusResponse) => {
          if (!cancelled) setData(json);
        })
        .catch(() => {
          // Best-effort; keep showing the last known state rather than flashing an error.
        });
    }
    poll();
    const pollId = setInterval(poll, POLL_INTERVAL_MS);
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  if (!data) return null;

  const cooldownActive = data.cooldownUntil !== null && data.cooldownUntil > now;

  if (data.haltedForToday) {
    return (
      <div className="rounded-lg border border-rose-800 bg-rose-950/40 px-3.5 py-2 text-sm">
        <span className="font-bold text-rose-400">AUTOPILOT LOCKED</span>
        <span className="ml-2 text-rose-300">
          Daily loss limit ({data.maxDailyLossPct}%) reached on {data.account}. No new trades until the next trading day.
        </span>
      </div>
    );
  }

  if (cooldownActive && data.cooldownUntil) {
    return (
      <div className="rounded-lg border border-amber-700 bg-amber-950/40 px-3.5 py-2 text-sm">
        <span className="font-bold text-amber-400">COOLDOWN ACTIVE</span>
        <span className="ml-2 text-amber-300">
          {data.maxConsecutiveLosses} consecutive losses on {data.account} -- resumes in {formatRemaining(data.cooldownUntil, now)}.
        </span>
      </div>
    );
  }

  return null;
}
