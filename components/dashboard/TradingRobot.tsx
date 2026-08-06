interface TradingRobotProps {
  direction: "long" | "short";
}

const CONFIG = {
  long: {
    name: "JUDE",
    callout: "BUY NOW",
    ring: "ring-emerald-400",
    glow: "shadow-[0_0_28px_var(--color-emerald-400)]",
    bg: "bg-emerald-500/15",
    text: "text-emerald-400",
    arrowRotation: "rotate-0", // arrow points up by default
  },
  short: {
    name: "OMINI",
    callout: "SELL NOW",
    ring: "ring-rose-400",
    glow: "shadow-[0_0_28px_var(--color-rose-400)]",
    bg: "bg-rose-500/15",
    text: "text-rose-400",
    arrowRotation: "rotate-180", // flipped to point down
  },
} as const;

/** The Jude/Omini robot badge: green pointing up for a long signal, red pointing down for short. */
export function TradingRobot({ direction }: TradingRobotProps) {
  const cfg = CONFIG[direction];
  return (
    <div className="flex items-center gap-3">
      <div className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full ring-2 ${cfg.ring} ${cfg.bg} ${cfg.glow}`}>
        <span className="text-2xl" role="img" aria-label={`${cfg.name} robot`}>
          🤖
        </span>
        <svg
          className={`absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-zinc-900 p-0.5 ${cfg.text} ${cfg.arrowRotation}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </div>
      <div>
        <div className={`text-sm font-bold tracking-wide ${cfg.text}`}>{cfg.name}</div>
        <div className="text-xs font-semibold text-zinc-300">{cfg.callout}</div>
      </div>
    </div>
  );
}
