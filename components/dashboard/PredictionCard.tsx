"use client";

import type { NoTradeReason, PredictionUpdate } from "@/lib/market/types";
import { predictionHeadline, predictionSubline, type PredictionHeadline } from "@/lib/market/predictionLabel";
import { describeNoTradeReason } from "@/lib/market/noTradeReason";
import { TIMEFRAME_MS } from "@/lib/market/timeframes";
import { CONFLUENCE_LABEL } from "./SignalsPanel";
import { DirectionBadge, type BadgeTone } from "./DirectionBadge";
import { SignerBBreakdown } from "./SignerBBreakdown";

const HEADLINE_TONE: Record<PredictionHeadline, BadgeTone> = {
  "STRONG BUY": "positive",
  BUY: "positive",
  NEUTRAL: "neutral",
  SELL: "negative",
  "STRONG SELL": "negative",
  "NO TRADE": "neutral",
};

// A signal that's more than this many of its own timeframe bars old is shown as
// outdated -- predictions refresh every closed candle, so anything holding this long
// past its own creation is more likely a stalled poll/stream than a fresh read.
const STALE_BAR_MULTIPLE = 3;

function isStale(createdAt: number, timeframe: keyof typeof TIMEFRAME_MS): boolean {
  return Date.now() - createdAt > TIMEFRAME_MS[timeframe] * STALE_BAR_MULTIPLE;
}

/** Reason-specific status badge for the no_trade branch -- CONFLICTING/NEUTRAL only
 * ever come from a genuine Signer B read (never fabricated); every other gate reads as
 * a plain WAIT. This is the one place those two Signer B-specific reasons get their
 * own visual treatment -- "Active Signals" (SignalsPanel.tsx) can never show them at
 * all, since a conflicting/neutral Signer B read never becomes a stored Signal in the
 * first place (see decisionMatrix.ts). */
function noTradeStatus(reason: NoTradeReason): { tone: BadgeTone; label: string } {
  if (reason.code === "signer_conflict") return { tone: "negative", label: "CONFLICTING" };
  if (reason.code === "signer_b_neutral") return { tone: "neutral", label: "NEUTRAL" };
  return { tone: "neutral", label: "WAIT" };
}

/**
 * Surfaces the SMC engine's real per-candle evaluation for the selected pair -- either
 * a qualifying Signal (direction/confidence/evidence) or an honest NO TRADE with the
 * real reason it didn't qualify. Every value shown here traces to a real field on
 * PredictionUpdate; nothing is fabricated or estimated client-side.
 */
export function PredictionCard({ update }: { update: PredictionUpdate | null }) {
  if (!update) {
    return <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3 text-sm text-zinc-500">Evaluating…</div>;
  }

  const headline = predictionHeadline(update.evaluation);
  const subline = predictionSubline(update.evaluation);

  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <div className="flex items-center justify-between">
        <DirectionBadge tone={HEADLINE_TONE[headline]} label={headline} />
        {update.evaluation.status === "signal" && (
          <span className="text-sm font-semibold text-zinc-200">{update.evaluation.signal.confidence.toFixed(0)}% confidence</span>
        )}
      </div>

      {subline && <p className="mt-1.5 text-xs text-zinc-400">{subline}</p>}

      {update.evaluation.status === "signal" ? (
        <>
          {isStale(update.evaluation.signal.createdAt, update.evaluation.signal.timeframe) && (
            <p className="mt-1.5 text-xs font-semibold text-amber-400">⚠️ Analysis outdated -- waiting on a fresh candle close.</p>
          )}
          {update.evaluation.signal.confluences.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {update.evaluation.signal.confluences.map((c) => (
                <span key={c} className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[11px] text-zinc-300">
                  {CONFLUENCE_LABEL[c]}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-zinc-500">
            SMC (Signer A) &middot; Direction {update.evaluation.signal.directionScore.toFixed(0)}% &middot; Entry{" "}
            {update.evaluation.signal.entryScore.toFixed(0)}%
          </div>
          <div className="mt-2 border-t border-white/10 pt-2">
            <SignerBBreakdown signal={update.evaluation.signal} />
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <DirectionBadge tone={noTradeStatus(update.evaluation.reason).tone} label={noTradeStatus(update.evaluation.reason).label} className="text-xs" />
            {update.evaluation.reason.code === "signer_conflict" && (
              <span className="text-[11px] text-zinc-500">
                SMC {update.evaluation.reason.impliedDirection === "long" ? "BUY" : "SELL"} · Signer B{" "}
                {update.evaluation.reason.signerBDirection === "long" ? "BUY" : "SELL"} ({update.evaluation.reason.signerBConfidence.toFixed(0)}%)
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs text-zinc-400">{describeNoTradeReason(update.evaluation.reason)}</p>
        </>
      )}
    </div>
  );
}
