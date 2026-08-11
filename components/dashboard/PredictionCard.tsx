"use client";

import type { PredictionUpdate } from "@/lib/market/types";
import { predictionHeadline, predictionSubline, type PredictionHeadline } from "@/lib/market/predictionLabel";
import { describeNoTradeReason } from "@/lib/market/noTradeReason";
import { CONFLUENCE_LABEL } from "./SignalsPanel";

const HEADLINE_CLASSES: Record<PredictionHeadline, string> = {
  "STRONG BUY": "bg-emerald-500/15 text-emerald-400",
  BUY: "bg-emerald-500/15 text-emerald-400",
  NEUTRAL: "bg-zinc-700/60 text-zinc-300",
  SELL: "bg-rose-500/15 text-rose-400",
  "STRONG SELL": "bg-rose-500/15 text-rose-400",
  "NO TRADE": "bg-zinc-800 text-zinc-500",
};

const STATUS_COLOR = {
  positive: "text-emerald-400",
  negative: "text-rose-400",
  neutral: "text-zinc-500",
} as const;

/** Maps one Signer B factor's raw reading to a tone against this signal's own
 * direction -- "unavailable"/"neutral" readings are real, honest non-answers (never
 * fabricated as agreeing or disagreeing), so they stay neutral rather than reading as
 * a disagreement. */
function agreeTone<T extends string>(
  value: T | "neutral" | "unavailable",
  direction: "long" | "short",
  bullishValue: T,
  bearishValue: T
): keyof typeof STATUS_COLOR {
  if (value === "unavailable" || value === "neutral") return "neutral";
  const wanted = direction === "long" ? bullishValue : bearishValue;
  return value === wanted ? "positive" : "negative";
}

/** One row of the confirmation-layer breakdown -- always shows the real status,
 * including "unavailable", never a fabricated agree/disagree. */
function ConfirmationRow({ label, value, tone }: { label: string; value: string; tone: keyof typeof STATUS_COLOR }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className={STATUS_COLOR[tone]}>{value}</span>
    </div>
  );
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
        <span className={`inline-block rounded-full px-2.5 py-1 text-sm font-semibold ${HEADLINE_CLASSES[headline]}`}>{headline}</span>
        {update.evaluation.status === "signal" && (
          <span className="text-sm font-semibold text-zinc-200">{update.evaluation.signal.confidence.toFixed(0)}% confidence</span>
        )}
      </div>

      {subline && <p className="mt-1.5 text-xs text-zinc-400">{subline}</p>}

      {update.evaluation.status === "signal" ? (
        <>
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
            <div className="flex items-center justify-between text-[11px] text-zinc-500">
              <span>Signer B (independent confirmation)</span>
              <span className={STATUS_COLOR[update.evaluation.signal.signerBDirection === "unavailable" ? "neutral" : "positive"]}>
                {update.evaluation.signal.signerBDirection === "unavailable"
                  ? "Unavailable"
                  : `${update.evaluation.signal.signerBDirection.toUpperCase()} · ${update.evaluation.signal.signerBConfidence.toFixed(0)}%`}
              </span>
            </div>
            <div className="mt-1 space-y-1 text-[11px]">
              <ConfirmationRow
                label="EMA trend"
                value={
                  update.evaluation.signal.signerBEmaTrend === "unavailable"
                    ? "Unavailable"
                    : update.evaluation.signal.signerBEmaTrend.charAt(0).toUpperCase() + update.evaluation.signal.signerBEmaTrend.slice(1)
                }
                tone={agreeTone(update.evaluation.signal.signerBEmaTrend, update.evaluation.signal.direction, "bullish", "bearish")}
              />
              <ConfirmationRow
                label="Supertrend"
                value={update.evaluation.signal.supertrendTrend === "unavailable" ? "Unavailable" : update.evaluation.signal.supertrendTrend.toUpperCase()}
                tone={agreeTone(update.evaluation.signal.supertrendTrend, update.evaluation.signal.direction, "up", "down")}
              />
              <ConfirmationRow
                label="RSI divergence"
                value={
                  update.evaluation.signal.rsiDivergence === "unavailable"
                    ? "Unavailable"
                    : update.evaluation.signal.rsiDivergence === "none"
                      ? "None"
                      : update.evaluation.signal.rsiDivergence.charAt(0).toUpperCase() + update.evaluation.signal.rsiDivergence.slice(1)
                }
                tone={
                  update.evaluation.signal.rsiDivergence === "unavailable" || update.evaluation.signal.rsiDivergence === "none"
                    ? "neutral"
                    : agreeTone(update.evaluation.signal.rsiDivergence, update.evaluation.signal.direction, "bullish", "bearish")
                }
              />
              <ConfirmationRow
                label="Currency strength"
                value={
                  update.evaluation.signal.usdStrengthStatus === "unavailable"
                    ? "Unavailable"
                    : update.evaluation.signal.usdStrengthStatus === "supports"
                      ? "Supports"
                      : "Conflicts"
                }
                tone={
                  update.evaluation.signal.usdStrengthStatus === "unavailable"
                    ? "neutral"
                    : update.evaluation.signal.usdStrengthStatus === "supports"
                      ? "positive"
                      : "negative"
                }
              />
              <ConfirmationRow label="Session" value={update.evaluation.signal.session} tone="neutral" />
              <ConfirmationRow
                label="News"
                value={
                  update.evaluation.signal.newsStatus === "unavailable"
                    ? "Unavailable"
                    : update.evaluation.signal.newsStatus === "clear"
                      ? "Clear"
                      : "High-impact soon"
                }
                tone={
                  update.evaluation.signal.newsStatus === "unavailable"
                    ? "neutral"
                    : update.evaluation.signal.newsStatus === "clear"
                      ? "positive"
                      : "negative"
                }
              />
            </div>
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-xs text-zinc-400">{describeNoTradeReason(update.evaluation.reason)}</p>
      )}
    </div>
  );
}
