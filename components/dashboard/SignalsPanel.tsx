"use client";

import { memo, useState } from "react";
import { UNSCORED_SOURCE_LABEL, type Confluence, type HigherTimeframeTrends, type MarketRegime, type Pair, type PredictionUpdate, type Signal, type Timeframe } from "@/lib/market/types";
import type { CardStatus, ExecuteResponse } from "@/lib/market/executionClient";
import { formatPrice } from "@/lib/market/format";
import { REGIME_LABEL } from "@/lib/market/noTradeReason";
import { TradingRobot } from "./TradingRobot";
import { DirectionBadge, directionTone } from "./DirectionBadge";
import { SignerBBreakdown } from "./SignerBBreakdown";
import { SetupQualityBreakdown } from "./SetupQualityBreakdown";
import { TradeProposalCard, describeExecuteResponse } from "./TradeProposalCard";

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
  range_regime: "Range regime",
  boundary_touch: "Boundary touch",
  rsi_extreme: "RSI extreme",
  rejection_candle: "Rejection candle",
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

function statusMessage(result: ExecuteResponse): { text: string; tone: "positive" | "negative" | "neutral" } {
  if (result.status === "filled") return { text: describeExecuteResponse(result), tone: "positive" };
  if (result.status === "blocked" || result.status === "skipped_sizing" || result.status === "expired") {
    return { text: describeExecuteResponse(result), tone: "negative" };
  }
  if (result.status === "rejected" || result.status === "not_found" || result.status === "network_error") {
    return { text: describeExecuteResponse(result), tone: "negative" };
  }
  return { text: describeExecuteResponse(result), tone: "neutral" };
}

const STATUS_TONE_CLASS: Record<"positive" | "negative" | "neutral", string> = {
  positive: "text-emerald-400",
  negative: "text-rose-400",
  neutral: "text-zinc-500",
};

/**
 * The AI never places a trade on its own -- a signal only ever becomes a Trade Proposal
 * (see TradeProposalCard) once the user deliberately opens it by clicking Buy/Sell, and
 * even then nothing reaches MT5 without a further explicit Approve. In "signal_only"
 * mode there's no execute affordance at all, matching Mode 1 of the spec this
 * implements: the AI analyzes and shows signals, and can never place one.
 */
function ExecuteControl({
  signal,
  status,
  trends,
  manualMode,
  ttlSeconds,
  defaultRiskPct,
  onApprove,
}: {
  signal: Signal;
  status: CardStatus;
  trends: HigherTimeframeTrends | undefined;
  manualMode: "signal_only" | "confirm";
  ttlSeconds: number;
  defaultRiskPct: number;
  onApprove: (riskPctOverride: number) => void;
}) {
  const [proposalOpen, setProposalOpen] = useState(false);

  // Watch-tier never cleared the buy/strong_buy confidence bar — shown for information
  // only, with no button at all (attemptExecution also rejects it server-side).
  if (signal.tier === "watch") {
    return <p className="mt-2 text-xs font-medium text-zinc-500">Below confidence threshold — informational only</p>;
  }

  if (status.state === "done") {
    const { text, tone } = statusMessage(status.result);
    return <p className={`mt-2 text-xs font-medium ${STATUS_TONE_CLASS[tone]}`}>{text}</p>;
  }

  if (manualMode === "signal_only") {
    return <p className="mt-2 text-xs font-medium text-zinc-500">Signal Only mode — nothing executes automatically</p>;
  }

  if (proposalOpen) {
    return (
      <TradeProposalCard
        signal={signal}
        trends={trends}
        ttlSeconds={ttlSeconds}
        defaultRiskPct={defaultRiskPct}
        busy={status.state === "loading"}
        onApprove={onApprove}
        onDismiss={() => setProposalOpen(false)}
      />
    );
  }

  const isLong = signal.direction === "long";
  const label = isLong ? "Buy" : "Sell";
  const colorClasses = isLong ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500";

  return (
    <button
      type="button"
      onClick={() => setProposalOpen(true)}
      className={`mt-2 w-full rounded-md px-3 py-1.5 text-xs font-semibold text-white transition ${colorClasses}`}
    >
      {label}
    </button>
  );
}

// Memoized so a Dashboard-level re-render (e.g. an SSE price tick for an unrelated
// pair) doesn't re-run every card's own work (SetupQualityBreakdown/SignerBBreakdown
// scoring) unless this specific signal's own props actually changed. Only effective
// because every prop passed in from SignalsPanel's map below is now reference-stable
// across renders (see the IDLE_STATUS/onExecute handling there) -- an inline arrow
// function or fresh object literal passed as a prop would defeat this immediately.
const SignalCard = memo(function SignalCard({
  signal,
  status,
  onExecute,
  regime,
  trends,
  manualMode,
  ttlSeconds,
  defaultRiskPct,
}: {
  signal: Signal;
  status: CardStatus;
  onExecute: (signal: Signal, riskPctOverride: number) => void;
  regime: MarketRegime | undefined;
  trends: HigherTimeframeTrends | undefined;
  manualMode: "signal_only" | "confirm";
  ttlSeconds: number;
  defaultRiskPct: number;
}) {
  return (
    <li className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <div className="flex items-center justify-between">
        <TradingRobot direction={signal.direction} />
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <div className="font-semibold text-zinc-100">{signal.pair}</div>
            {regime && <span className="rounded-full bg-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-400">{REGIME_LABEL[regime]}</span>}
          </div>
          <div className="mt-1">
            <DirectionBadge
              tone={directionTone(signal.direction)}
              label={`${TIER_LABEL[signal.tier]} · ${signal.confidence.toFixed(0)}% · ${signal.timeframe}`}
              className="text-xs"
            />
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {UNSCORED_SOURCE_LABEL[signal.source] ?? `Direction ${signal.directionScore.toFixed(0)}% · Entry ${signal.entryScore.toFixed(0)}%`}
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
      {/* TradingView-sourced signals carry hardcoded placeholder scores (see
          tradingViewWebhook.ts), never real SMC-derived ones -- a quality breakdown off
          those would fabricate meaning that isn't there, same reasoning as the
          SignerBBreakdown exclusion above. */}
      {signal.source !== "tradingview" && regime && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <SetupQualityBreakdown signal={signal} regime={regime} />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          R:R {signal.riskReward.toFixed(1)} &middot; {signal.session}
        </span>
        <span>{relativeTime(signal.createdAt)}</span>
      </div>
      <ExecuteControl
        signal={signal}
        status={status}
        trends={trends}
        manualMode={manualMode}
        ttlSeconds={ttlSeconds}
        defaultRiskPct={defaultRiskPct}
        onApprove={(riskPctOverride) => onExecute(signal, riskPctOverride)}
      />
    </li>
  );
});

// A fresh `{ state: "idle" }` object literal per signal per render (the old fallback
// below) would defeat SignalCard's memoization for every signal with no status yet --
// hoisted so the fallback reference is stable across renders.
const IDLE_STATUS: CardStatus = { state: "idle" };

export function SignalsPanel({
  signals,
  statuses,
  onExecute,
  predictions,
  manualMode,
  ttlSeconds,
  defaultRiskPct,
  loaded = true,
}: {
  signals: Signal[];
  statuses: Record<string, CardStatus>;
  onExecute: (signal: Signal, riskPctOverride: number) => void;
  /** Current per-pair/timeframe regime read, same map Dashboard.tsx already keeps for
   * PredictionCard.tsx -- reflects the market's CURRENT regime, not necessarily the
   * regime at the moment this (possibly older) signal fired. Optional so callers that
   * don't track predictions (none currently) can still render the panel. */
  predictions?: Partial<Record<Pair, Partial<Record<Timeframe, PredictionUpdate>>>>;
  /** Confirmation Mode's current manual-execution mode -- "signal_only" shows no
   * execute affordance at all, "confirm" is the default propose-then-approve flow.
   * See confirmationMode.ts. */
  manualMode: "signal_only" | "confirm";
  ttlSeconds: number;
  defaultRiskPct: number;
  /** Whether the initial signals snapshot has resolved yet -- distinguishes "still
   * loading" from "genuinely zero signals" so the two don't show identical copy.
   * Defaults true so callers that don't track this (none currently) see today's
   * behavior unchanged. */
  loaded?: boolean;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Active signals</h2>
      {signals.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">{loaded ? "No signals yet — watching for setups." : "Loading signals…"}</p>
      ) : (
        <ul className="space-y-2">
          {signals.map((signal) => (
            <SignalCard
              key={signal.id}
              signal={signal}
              status={statuses[signal.id] ?? IDLE_STATUS}
              onExecute={onExecute}
              regime={predictions?.[signal.pair]?.[signal.timeframe]?.regime}
              trends={predictions?.[signal.pair]?.[signal.timeframe]?.trends}
              manualMode={manualMode}
              ttlSeconds={ttlSeconds}
              defaultRiskPct={defaultRiskPct}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
