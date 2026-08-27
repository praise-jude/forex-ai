"use client";

import { useEffect, useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

interface RiskStatusResponse {
  account: "live" | "demo";
  haltedForToday: boolean;
  cooldownUntil: number | null;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  maxDailyLossPct: number;
  requiresAcknowledgement: boolean;
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
  // Shared with useVoiceAssistant.ts, which polls this exact same "risk-status" key --
  // usePolledResource dedupes them into a single interval/request instead of two.
  const { data, setData } = usePolledResource<RiskStatusResponse>(
    "risk-status",
    () => fetch("/api/risk-status").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [now, setNow] = useState(() => Date.now());
  const [acknowledging, setAcknowledging] = useState(false);
  const [forceResuming, setForceResuming] = useState(false);

  async function acknowledge() {
    setAcknowledging(true);
    try {
      const res = await fetch("/api/risk-status/acknowledge", { method: "POST" });
      if (res.ok && data) setData({ ...data, requiresAcknowledgement: false });
    } finally {
      setAcknowledging(false);
    }
  }

  // A deliberate override of an ACTIVE daily-loss halt, not the routine "condition
  // already cleared" acknowledge() above -- confirmed separately since this re-arms
  // trading on the exact account/day that just tripped the limit.
  async function forceResume() {
    if (!window.confirm("Force-resume trading today? The daily loss limit already tripped -- this re-arms new trades on the same day, same account, before it would normally clear.")) {
      return;
    }
    setForceResuming(true);
    try {
      const res = await fetch("/api/risk-status/force-resume", { method: "POST" });
      if (res.ok && data) setData({ ...data, haltedForToday: false, requiresAcknowledgement: false });
    } finally {
      setForceResuming(false);
    }
  }

  // Same override shape as forceResume above, but for the consecutive-loss cooldown --
  // see riskState.ts's forceResetCooldown doc comment.
  async function forceResumeCooldown() {
    if (!window.confirm(`Force-resume trading now? The ${data?.maxConsecutiveLosses ?? 3}-consecutive-loss cooldown already tripped -- this clears it before the timer would normally lift it.`)) {
      return;
    }
    setForceResuming(true);
    try {
      const res = await fetch("/api/risk-status/force-resume-cooldown", { method: "POST" });
      if (res.ok && data) setData({ ...data, cooldownUntil: null, consecutiveLosses: 0, requiresAcknowledgement: false });
    } finally {
      setForceResuming(false);
    }
  }

  useEffect(() => {
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickId);
  }, []);

  if (!data) return null;

  const cooldownActive = data.cooldownUntil !== null && data.cooldownUntil > now;

  if (data.haltedForToday) {
    // This "AUTOPILOT LOCKED" headline is this component's own, independent of
    // AutopilotLockControl.tsx's manual lock switch (deliberately labeled "AUTO-
    // EXECUTION LOCKED" instead, precisely to avoid being confused with this one) --
    // this one is the automatic daily-loss guardian tripping, not an operator toggle.
    return (
      <div className="flex items-center justify-between rounded-lg border border-rose-800 bg-rose-950/40 px-3.5 py-2 text-sm">
        <span>
          <span className="font-bold text-rose-400">AUTOPILOT LOCKED</span>
          <span className="ml-2 text-rose-300">
            Daily loss limit ({data.maxDailyLossPct}%) reached on {data.account}. No new trades until the next trading day.
          </span>
        </span>
        <button
          type="button"
          onClick={forceResume}
          disabled={forceResuming}
          className="ml-3 shrink-0 rounded-md border border-rose-700 bg-rose-900/60 px-2.5 py-1 text-xs font-semibold text-rose-200 transition hover:bg-rose-800/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {forceResuming ? "Resuming…" : "Force resume today"}
        </button>
      </div>
    );
  }

  if (cooldownActive && data.cooldownUntil) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-amber-700 bg-amber-950/40 px-3.5 py-2 text-sm">
        <span>
          <span className="font-bold text-amber-400">COOLDOWN ACTIVE</span>
          <span className="ml-2 text-amber-300">
            {data.maxConsecutiveLosses} consecutive losses on {data.account} -- resumes in {formatRemaining(data.cooldownUntil, now)}.
          </span>
        </span>
        <button
          type="button"
          onClick={forceResumeCooldown}
          disabled={forceResuming}
          className="ml-3 shrink-0 rounded-md border border-amber-700 bg-amber-900/60 px-2.5 py-1 text-xs font-semibold text-amber-200 transition hover:bg-amber-800/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {forceResuming ? "Resuming…" : "Force resume"}
        </button>
      </div>
    );
  }

  // The halt/cooldown condition itself has cleared (day rolled over, timer expired),
  // but DEMO/LIVE auto-execution stays paused until a human deliberately reviews and
  // resumes it -- see riskState.ts's own reasoning. Manual confirm-mode execution is
  // never affected by this (a human already reviews every trade there).
  if (data.requiresAcknowledgement) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-amber-700 bg-amber-950/40 px-3.5 py-2 text-sm">
        <span>
          <span className="font-bold text-amber-400">PAUSED, AWAITING REVIEW</span>
          <span className="ml-2 text-amber-300">
            The daily loss limit or consecutive-loss cooldown on {data.account} has cleared, but auto-execution stays paused until you
            resume it.
          </span>
        </span>
        <button
          type="button"
          onClick={acknowledge}
          disabled={acknowledging}
          className="ml-3 shrink-0 rounded-md border border-amber-700 bg-amber-900/60 px-2.5 py-1 text-xs font-semibold text-amber-200 transition hover:bg-amber-800/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {acknowledging ? "Resuming…" : "Resume trading"}
        </button>
      </div>
    );
  }

  return null;
}
