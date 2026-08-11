"use client";

import { useEffect, useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

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

// /api/connection-status is a synchronous in-memory read (see its route handler) --
// no external I/O, so polling it tightly costs nothing on the backend. Was 7000ms;
// dropped to 2000ms so a real MT5 drop/restore shows up on screen within ~2s instead
// of up to 7s, matching the "fast connection status" this exists to convey.
const POLL_INTERVAL_MS = 2000;

function formatAgo(lastUpdateAt: number | null, now: number): string {
  if (lastUpdateAt === null) return "no data yet";
  const seconds = Math.max(0, Math.round((now - lastUpdateAt) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `updated ${minutes}m ago`;
}

async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/connection-status");
  return res.json();
}

export function ConnectionStatus() {
  const { data } = usePolledResource("connection-status", fetchStatus, POLL_INTERVAL_MS);
  const [now, setNow] = useState(() => Date.now());

  // Ticks independently of the poll so "updated Xs ago" stays smooth between fetches --
  // matched to the poll interval itself now, not a separate faster 1s timer.
  useEffect(() => {
    const tickId = setInterval(() => setNow(Date.now()), POLL_INTERVAL_MS);
    return () => clearInterval(tickId);
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
