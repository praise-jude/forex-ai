/**
 * One reusable badge for every BUY/SELL/WAIT/UNAVAILABLE indicator in the dashboard --
 * color, shape, and label always driven by the same 4-tone system, never hand-rolled
 * per component. Exists specifically because `SignalsPanel.tsx`'s tier badge used to
 * color itself by confidence tier alone, landing on the same sky-blue for a SELL
 * signal as a BUY signal -- routing every badge through this one component means that
 * class of bug can't reappear independently in a different file later.
 *
 * `positive`/`negative` double as both "long direction"/"short direction" (▲/▼) and
 * "confirmed"/"conflicting" confluence status (same green/red, same shapes) -- one
 * tone system serves both use cases in this app. `neutral` is WAIT/NEUTRAL (amber),
 * `unavailable` is missing data (gray) -- explicitly distinct from `neutral`, since
 * "no lean" and "no data" are different, honest states that must never be conflated.
 * Shape + color + text together (never color alone), per this app's own accessibility
 * requirement.
 */
export type BadgeTone = "positive" | "negative" | "neutral" | "unavailable";

const TONE_CLASSES: Record<BadgeTone, string> = {
  positive: "bg-emerald-500/15 text-emerald-400",
  negative: "bg-rose-500/15 text-rose-400",
  neutral: "bg-amber-500/15 text-amber-400",
  unavailable: "bg-zinc-800 text-zinc-500",
};

const TONE_ICON: Record<BadgeTone, string> = {
  positive: "▲",
  negative: "▼",
  neutral: "●",
  unavailable: "○",
};

export function DirectionBadge({ tone, label, className = "" }: { tone: BadgeTone; label: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold ${TONE_CLASSES[tone]} ${className}`}
    >
      <span aria-hidden="true">{TONE_ICON[tone]}</span>
      {label}
    </span>
  );
}

/** `direction`-only convenience -- the overwhelmingly common case (BUY/SELL badges
 * throughout the dashboard never need the neutral/unavailable tones). */
export function directionTone(direction: "long" | "short"): BadgeTone {
  return direction === "long" ? "positive" : "negative";
}
