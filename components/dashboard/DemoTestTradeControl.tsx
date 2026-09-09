"use client";

import { useState } from "react";
import { PAIRS, type Pair } from "@/lib/market/types";
import type { ExecuteResponse } from "@/lib/market/executionClient";
import { describeExecuteResponse } from "./TradeProposalCard";

type DryRunResponse =
  | { status: "blocked"; code: string; reason: string }
  | { status: "skipped_sizing"; reason: string }
  | { status: "dry_run_ok"; lots: number; entry: number; stopLoss: number; takeProfit: number; marginRequired: number | null; freeMargin: number }
  | { status: "dry_run_failed"; reason: string }
  | { status: "network_error" };

function describeDryRunResponse(result: DryRunResponse): string {
  switch (result.status) {
    case "dry_run_ok":
      return `✓ Pipeline works -- lots ${result.lots}, entry ${result.entry}, margin required ${result.marginRequired === null ? "n/a" : `$${result.marginRequired.toFixed(2)}`} (free margin $${result.freeMargin.toFixed(2)}). No order was placed.`;
    case "dry_run_failed":
      return `✗ Broker round trip failed: ${result.reason}`;
    case "blocked":
      return `Blocked before reaching the broker: ${result.reason}`;
    case "skipped_sizing":
      return `Skipped: ${result.reason}`;
    case "network_error":
      return "Network error — try again";
  }
}

/**
 * "Does DEMO order placement actually work right now" -- independent of whether the real
 * SMC/range engines currently find a qualifying setup (see app/api/signals/test-trade's
 * own doc comment for why that's a genuinely separate question worth answering on its
 * own). Places a real, synthetic-but-honestly-labeled order on the DEMO account through
 * the exact same risk-checked execution path every other signal uses -- there's no engine
 * mode toggle here on purpose: this always targets DEMO, never LIVE, regardless of
 * whatever /dashboard's mode selector is currently set to.
 *
 * A real, confirmed gap (2026-09-09): this deployment has no demo account configured at
 * all, so the DEMO button below has been silently unreachable this whole time -- just a
 * "set METAAPI_DEMO_TOKEN" message with no way to actually test anything. The "dry run"
 * button is the fix: same real pipeline, targets LIVE (the only real account here)
 * through attemptDryRun, but the final step is a pure, read-only broker margin
 * calculation instead of a real order -- proves the whole chain (signal → risk checks →
 * sizing → broker round trip) works, with zero funds ever at risk.
 */
export function DemoTestTradeControl({ demoConfigured }: { demoConfigured: boolean }) {
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [busy, setBusy] = useState<"demo" | "dryRun" | null>(null);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResponse | null>(null);

  async function placeTestTrade() {
    setBusy("demo");
    setResult(null);
    setDryRunResult(null);
    try {
      const res = await fetch("/api/signals/test-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair, direction }),
      });
      setResult((await res.json()) as ExecuteResponse);
    } catch {
      setResult({ status: "network_error" });
    } finally {
      setBusy(null);
    }
  }

  async function runDryRun() {
    setBusy("dryRun");
    setResult(null);
    setDryRunResult(null);
    try {
      const res = await fetch("/api/signals/test-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair, direction, dryRun: true }),
      });
      setDryRunResult((await res.json()) as DryRunResponse);
    } catch {
      setDryRunResult({ status: "network_error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">
        Proves the real signal → risk-check → sizing → broker pipeline works, independent of whether SMC/the range engine currently find a
        qualifying setup.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={pair}
          onChange={(e) => setPair(e.target.value as Pair)}
          className="rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100"
        >
          {PAIRS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as "long" | "short")}
          className="rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100"
        >
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <button
          type="button"
          onClick={runDryRun}
          disabled={busy !== null}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "dryRun" ? "Checking…" : "🔬 Dry run (LIVE, no real order)"}
        </button>
        {demoConfigured && (
          <button
            type="button"
            onClick={placeTestTrade}
            disabled={busy !== null}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "demo" ? "Placing…" : "🧪 Place DEMO test trade"}
          </button>
        )}
      </div>
      {!demoConfigured && (
        <p className="text-xs text-zinc-500">
          No demo account is configured (<code className="font-mono">METAAPI_DEMO_TOKEN</code>/
          <code className="font-mono">METAAPI_DEMO_ACCOUNT_ID</code>) -- use &ldquo;Dry run&rdquo; above instead, which is always available and
          never risks real funds.
        </p>
      )}
      {result && <p className="text-xs font-semibold text-zinc-300">{describeExecuteResponse(result)}</p>}
      {dryRunResult && <p className="text-xs font-semibold text-zinc-300">{describeDryRunResponse(dryRunResult)}</p>}
    </div>
  );
}
