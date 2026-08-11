"use client";

import type { Confluence, Signal } from "@/lib/market/types";
import type { CardStatus } from "@/lib/market/executionClient";
import { formatPrice } from "@/lib/market/format";
import { TradingRobot } from "./TradingRobot";
import { DirectionBadge, directionTone } from "./DirectionBadge";
import { SignerBBreakdown } from "./SignerBBreakdown";

// Exported for reuse by PredictionCard.tsx -- one place a confluence tag's display
// name is defined, not duplicated between the two components that show them.
export const CONFLUENCE_LABEL: Record<Confluence, string> = {
  liquidity_sweep: "Liquidity sweep",
  bos: "Structure break (BOS)",
  choch: "Change of character (CHoCH)",
  fvg: "Fair value gap",
  order_block: "Order block",
  killzone: "Killzone",
  ema_trend: "EMA trend",
  rsi_momentum: "RSI momentum",
  macd_crossover: "MACD",
  volume: "Volume",
  trend_ema_stack: "EMA stack",
  market_structure: "Market structure",
  adx: "ADX",
  candlestick: "Candlestick",
  multi_timeframe: "D1/H4/H1 agreement",
  supertrend: "Supertrend",
  currency_strength: "Currency strength",
  rsi_divergence: "RSI divergence",
};

const TIER_LABEL: Record<Signal["tier"], string> = {
  strong_buy: "Strong buy",
  buy: "Buy",
  watch: "Watch",
};

function relativeTime(fromMs: number): string {
  const seconds = Math.round((Date.now() - fromMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function ExecuteControl({ signal, status, onExecute }: { signal: Signal; status: CardStatus; onExecute: () => void }) {
  // Watch-tier never cleared the buy/strong_buy confidence bar — shown for information
  // only, with no button at all (attemptExecution also rejects it server-side).
  if (signal.tier === "watch") {
    return <p className="mt-2 text-xs font-medium text-zinc-500">Below confidence threshold — informational only</p>;
  }

  const isLong = signal.direction === "long";
  const label = isLong ? "Buy" : "Sell";
  const colorClasses = isLong ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500";

  if (status.state === "done") {
    const { result } = status;
    switch (result.status) {
      case "filled":
        return (
          <p className="mt-2 text-xs font-medium text-emerald-400">
            Filled @ {formatPrice(signal.pair, result.trade.filledEntry ?? result.trade.requestedEntry)}
          </p>
        );
      case "rejected":
        return <p className="mt-2 text-xs font-medium text-rose-400">Rejected: {result.trade.rejectReason ?? "unknown reason"}</p>;
      case "blocked":
        return <p className="mt-2 text-xs font-medium text-amber-400">Blocked: {result.reason}</p>;
      case "skipped_sizing":
        return <p className="mt-2 text-xs font-medium text-amber-400">Skipped: {result.reason}</p>;
      case "duplicate":
        return <p className="mt-2 text-xs font-medium text-zinc-500">Already executed</p>;
      case "not_found":
        return <p className="mt-2 text-xs font-medium text-rose-400">Signal expired</p>;
      case "network_error":
        return <p className="mt-2 text-xs font-medium text-rose-400">Network error — try again</p>;
    }
  }

  return (
    <button
      type="button"
      onClick={onExecute}
      disabled={status.state === "loading"}
      className={`mt-2 w-full rounded-md px-3 py-1.5 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${colorClasses}`}
    >
      {status.state === "loading" ? "Placing order…" : label}
    </button>
  );
}

function SignalCard({ signal, status, onExecute }: { signal: Signal; status: CardStatus; onExecute: () => void }) {
  return (
    <li className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <div className="flex items-center justify-between">
        <TradingRobot direction={signal.direction} />
        <div className="text-right">
          <div className="font-semibold text-zinc-100">{signal.pair}</div>
          <div className="mt-1">
            <DirectionBadge
              tone={directionTone(signal.direction)}
              label={`${TIER_LABEL[signal.tier]} · ${signal.confidence.toFixed(0)}% · ${signal.timeframe}`}
              className="text-xs"
            />
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {signal.source === "tradingview"
              ? "Source: TradingView"
              : `Direction ${signal.directionScore.toFixed(0)}% · Entry ${signal.entryScore.toFixed(0)}%`}
          </div>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-4 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-zinc-500">Entry</dt>
          <dd className="text-zinc-200">{formatPrice(signal.pair, signal.entry)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">SL</dt>
          <dd className="text-rose-400">{formatPrice(signal.pair, signal.stopLoss)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">TP1</dt>
          <dd className="text-emerald-400">{formatPrice(signal.pair, signal.takeProfit)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">TP2</dt>
          <dd className="text-emerald-400">{formatPrice(signal.pair, signal.takeProfit2)}</dd>
        </div>
      </dl>
      {signal.confluences.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {signal.confluences.map((c) => (
            <span key={c} className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[11px] text-zinc-300">
              {CONFLUENCE_LABEL[c]}
            </span>
          ))}
        </div>
      )}
      {signal.source !== "tradingview" && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <SignerBBreakdown signal={signal} />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          R:R {signal.riskReward.toFixed(1)} &middot; {signal.session}
        </span>
        <span>{relativeTime(signal.createdAt)}</span>
      </div>
      <ExecuteControl signal={signal} status={status} onExecute={onExecute} />
    </li>
  );
}

export function SignalsPanel({
  signals,
  statuses,
  onExecute,
}: {
  signals: Signal[];
  statuses: Record<string, CardStatus>;
  onExecute: (signal: Signal) => void;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Active signals</h2>
      {signals.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No signals yet — watching for setups.</p>
      ) : (
        <ul className="space-y-2">
          {signals.map((signal) => (
            <SignalCard
              key={signal.id}
              signal={signal}
              status={statuses[signal.id] ?? { state: "idle" }}
              onExecute={() => onExecute(signal)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
