"use client";

import { useEffect, useState } from "react";

interface PollerEntry {
  data: unknown;
  error: string | null;
  intervalId: ReturnType<typeof setInterval>;
  subscribers: Set<(data: unknown, error: string | null) => void>;
  fetcher: () => Promise<unknown>;
}

// Module-scoped, not per-component -- multiple components calling usePolledResource with
// the SAME key share one interval and one in-flight fetch, mirroring this codebase's
// existing globalThis-keyed-singleton pattern (see lib/market/*Store.ts) at module scope
// instead of a server-side global. Fixes the confirmed duplicate-polling bug where
// EngineModeControl and useVoiceAssistant each independently hit /api/engine-mode (and
// RiskGuardianBanner + useVoiceAssistant each independently hit /api/risk-status) on
// identical 7s timers -- twice the network traffic for the same data.
const registry = new Map<string, PollerEntry>();

function notify(entry: PollerEntry): void {
  for (const subscriber of entry.subscribers) subscriber(entry.data, entry.error);
}

async function runFetch(key: string): Promise<void> {
  const entry = registry.get(key);
  if (!entry) return;
  try {
    entry.data = await entry.fetcher();
    entry.error = null;
  } catch (err) {
    // Best-effort, matching every poller this replaces -- keep showing the last known
    // value rather than flashing an error on a single missed poll.
    entry.error = err instanceof Error ? err.message : "Request failed";
  }
  notify(entry);
}

export interface PolledResource<T> {
  data: T | null;
  error: string | null;
  /** Patches the shared cache immediately (broadcasting to every subscriber of this key)
   * without waiting for the next interval tick -- e.g. EngineModeControl's optimistic
   * update right after a successful mode-switch POST. */
  setData: (next: T) => void;
  /** Forces an immediate fetch outside the regular interval. */
  refetch: () => void;
}

/**
 * Polls `key` on a shared interval, deduplicated across every component that calls this
 * hook with the same key -- only one network request fires per tick no matter how many
 * subscribers there are. The first subscriber for a key starts the interval and fires an
 * immediate fetch (matching every existing poller's "poll(); then setInterval(poll)"
 * behavior); the last subscriber to unmount clears it.
 */
export function usePolledResource<T>(key: string, fetcher: () => Promise<T>, intervalMs: number): PolledResource<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null }>(() => {
    const existing = registry.get(key);
    return { data: (existing?.data as T | undefined) ?? null, error: existing?.error ?? null };
  });

  useEffect(() => {
    let entry = registry.get(key);
    const isFirstSubscriber = !entry;
    if (!entry) {
      entry = {
        data: null,
        error: null,
        subscribers: new Set(),
        fetcher: fetcher as () => Promise<unknown>,
        intervalId: setInterval(() => void runFetch(key), intervalMs),
      };
      registry.set(key, entry);
    }

    const subscriber = (data: unknown, error: string | null) => setState({ data: data as T | null, error });
    entry.subscribers.add(subscriber);
    if (isFirstSubscriber) void runFetch(key);

    return () => {
      const current = registry.get(key);
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size === 0) {
        clearInterval(current.intervalId);
        registry.delete(key);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher intentionally not tracked: every caller for a given key passes an equivalent closure (same URL), and re-subscribing on every fetcher identity change would defeat the dedup this hook exists for.
  }, [key, intervalMs]);

  function setData(next: T): void {
    const entry = registry.get(key);
    if (!entry) return;
    entry.data = next;
    entry.error = null;
    notify(entry);
  }

  function refetch(): void {
    void runFetch(key);
  }

  return { data: state.data, error: state.error, setData, refetch };
}
