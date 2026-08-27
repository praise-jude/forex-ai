"use client";

import { useState } from "react";
import { PAIRS, type Pair } from "@/lib/market/types";
import type { ExecuteResponse } from "@/lib/market/executionClient";
import { describeExecuteResponse } from "./TradeProposalCard";

/**
 * "Does DEMO order placement actually work right now" -- independent of whether the real
 * SMC/range engines currently find a qualifying setup (see app/api/signals/test-trade's
 * own doc comment for why that's a genuinely separate question worth answering on its
 * own). Places a real, synthetic-but-honestly-labeled order on the DEMO account through
 * the exact same risk-checked execution path every other signal uses -- there's no engine
 * mode toggle here on purpose: this always targets DEMO, never LIVE, regardless of
 * whatever /dashboard's mode selector is currently set to.
 */
export function DemoTestTradeControl({ demoConfigured }: { demoConfigured: boolean }) {
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecuteResponse | null>(null);

  async function placeTestTrade() {
    setBusy(true);
    setResult(null);
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
      setBusy(false);
    }
  }

  if (!demoConfigured) {
    return (
      <p className="text-xs text-zinc-500">
        Set <code className="font-mono">METAAPI_DEMO_TOKEN</code>/<code className="font-mono">METAAPI_DEMO_ACCOUNT_ID</code> to enable a
        DEMO test trade.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">
        Places a real, synthetic order on the DEMO account (ATR-based stop/target, not a scored setup) to verify order placement actually
        works end to end -- independent of whether SMC/the range engine currently find a real setup. Always targets DEMO, regardless of the
        current engine mode above.
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
          onClick={placeTestTrade}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Placing…" : "🧪 Place DEMO test trade"}
        </button>
        {result && <span className="text-xs font-semibold text-zinc-300">{describeExecuteResponse(result)}</span>}
      </div>
    </div>
  );
}
