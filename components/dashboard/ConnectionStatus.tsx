"use client";

import { useEffect, useState } from "react";

type ConnectionStatus = "live" | "reconnecting" | "disconnected";

interface StatusResponse {
  status: ConnectionStatus;
  lastUpdateAt: number | null;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  live: "MT5 LIVE",
  reconnecting: "MT5 RECONNECTING",
  disconnected: "MT5 DISCONNECTED",
};

const STATUS_DOT_CLASSES: Record<ConnectionStatus, string> = {
  live: "bg-emerald-400",
  reconnecting: "bg-amber-400",
  disconnected: "bg-rose-500",
};

const POLL_INTERVAL_MS = 7000;

function formatAgo(lastUpdateAt: number | null, now: number): string {
  if (lastUpdateAt === null) return "no data yet";
  const seconds = Math.max(0, Math.round((now - lastUpdateAt) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `updated ${minutes}m ago`;
}

export function ConnectionStatus() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetch("/api/connection-status")
        .then((res) => res.json())
        .then((json: StatusResponse) => {
          if (!cancelled) setData(json);
        })
        .catch(() => {
          // Best-effort; keep showing the last known state rather than flashing an error.
        });
    }

    poll();
    const pollId = setInterval(poll, POLL_INTERVAL_MS);
    // Ticks independently of the poll so "updated Xs ago" stays smooth between fetches.
    const tickId = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      cancelled = true;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  if (!data) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT_CLASSES[data.status]}`} />
      <span className="font-semibold text-zinc-300">{STATUS_LABEL[data.status]}</span>
      <span>&middot; {formatAgo(data.lastUpdateAt, now)}</span>
    </div>
  );
}
