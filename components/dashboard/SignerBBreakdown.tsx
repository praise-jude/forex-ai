import type { Signal } from "@/lib/market/types";

export const STATUS_COLOR = {
  positive: "text-emerald-400",
  negative: "text-rose-400",
  neutral: "text-zinc-500",
} as const;

/** Maps one Signer B factor's raw reading to a tone against this signal's own
 * direction -- "unavailable"/"neutral" readings are real, honest non-answers (never
 * fabricated as agreeing or disagreeing), so they stay neutral rather than reading as
 * a disagreement. Exported so both PredictionCard.tsx and SignalsPanel.tsx render this
 * from one place -- never two independently-hand-rolled copies. */
export function agreeTone<T extends string>(
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
export function ConfirmationRow({ label, value, tone }: { label: string; value: string; tone: keyof typeof STATUS_COLOR }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className={STATUS_COLOR[tone]}>{value}</span>
    </div>
  );
}

/**
 * The full Signer B block (own direction+confidence headline, then every individual
 * factor) -- one component so the executable "Active Signals" panel and the
 * informational prediction card can never drift into showing different Signer B
 * detail for the same signal. Every value traces to a real `Signal` field; nothing is
 * fabricated or estimated client-side.
 */
export function SignerBBreakdown({ signal }: { signal: Signal }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>Signer B (independent confirmation)</span>
        <span className={STATUS_COLOR[signal.signerBDirection === "unavailable" || signal.signerBDirection === "neutral" ? "neutral" : "positive"]}>
          {signal.signerBDirection === "unavailable"
            ? "Unavailable"
            : signal.signerBDirection === "neutral"
              ? "Neutral"
              : `${signal.signerBDirection.toUpperCase()} · ${signal.signerBConfidence.toFixed(0)}%`}
        </span>
      </div>
      <div className="mt-1 space-y-1 text-[11px]">
        <ConfirmationRow
          label="EMA trend"
          value={signal.signerBEmaTrend === "unavailable" ? "Unavailable" : signal.signerBEmaTrend.charAt(0).toUpperCase() + signal.signerBEmaTrend.slice(1)}
          tone={agreeTone(signal.signerBEmaTrend, signal.direction, "bullish", "bearish")}
        />
        <ConfirmationRow
          label="ADX"
          value={Number.isNaN(signal.adx) ? "Unavailable" : `${signal.adx.toFixed(1)} — ${signal.adx >= 25 ? "Strong enough" : "Weak trend"}`}
          tone={Number.isNaN(signal.adx) ? "neutral" : signal.adx >= 25 ? "positive" : "negative"}
        />
        <ConfirmationRow label="RSI" value={Number.isNaN(signal.rsi) ? "Unavailable" : signal.rsi.toFixed(0)} tone="neutral" />
        <ConfirmationRow
          label="Supertrend"
          value={signal.supertrendTrend === "unavailable" ? "Unavailable" : signal.supertrendTrend.toUpperCase()}
          tone={agreeTone(signal.supertrendTrend, signal.direction, "up", "down")}
        />
        <ConfirmationRow
          label="RSI divergence"
          value={
            signal.rsiDivergence === "unavailable" ? "Unavailable" : signal.rsiDivergence === "none" ? "None" : signal.rsiDivergence.charAt(0).toUpperCase() + signal.rsiDivergence.slice(1)
          }
          tone={signal.rsiDivergence === "unavailable" || signal.rsiDivergence === "none" ? "neutral" : agreeTone(signal.rsiDivergence, signal.direction, "bullish", "bearish")}
        />
        <ConfirmationRow
          label="Currency strength"
          value={signal.usdStrengthStatus === "unavailable" ? "Unavailable" : signal.usdStrengthStatus === "supports" ? "Supports" : "Conflicts"}
          tone={signal.usdStrengthStatus === "unavailable" ? "neutral" : signal.usdStrengthStatus === "supports" ? "positive" : "negative"}
        />
        <ConfirmationRow label="Session" value={signal.session} tone="neutral" />
        <ConfirmationRow
          label="News"
          value={signal.newsStatus === "unavailable" ? "Unavailable" : signal.newsStatus === "clear" ? "Clear" : "High-impact soon"}
          tone={signal.newsStatus === "unavailable" ? "neutral" : signal.newsStatus === "clear" ? "positive" : "negative"}
        />
      </div>
    </div>
  );
}
