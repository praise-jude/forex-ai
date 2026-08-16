"use client";

/**
 * "How close is this to having real evidence behind it" -- every insufficient_data
 * calibration/breakdown bucket in this app (confidence calibration, Signer B
 * calibration, confluence-edge analytics) shares the exact same shape (sampleSize vs.
 * a minSamples threshold), so this is the one shared visual for all of them rather
 * than three hand-rolled bars. Amber (not emerald/rose) since this is neither a
 * positive nor negative outcome -- it's progress toward having enough data to know.
 */
export function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      {label && <p className="text-[11px] text-amber-400">{label}</p>}
    </div>
  );
}
