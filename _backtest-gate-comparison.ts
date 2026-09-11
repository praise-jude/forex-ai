// Ad-hoc comparison tool, same convention as _run-backtest.ts/_diag-backtest.ts --
// answers a real operator question (2026-09-11): "should we loosen the weak_trend_adx /
// low_volatility hard gates so the autopilot fires more often?" with real historical
// data instead of a guess from watching one quiet chart. Runs the SAME cached candle
// series through evaluateSignal multiple times, once per gate variant (baseline =
// today's live thresholds, plus loosened ATR/ADX variants via SignalEvaluationOverrides
// -- see signalEngine.ts's own doc comment on that type), and prints a side-by-side
// win-rate/profit-factor/trade-count table. Never touches live gates itself -- this is
// purely read-only analysis; a real change only happens if the numbers below justify it.
import { config } from "dotenv";
config({ path: "./.env.local" });

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_IN_DAYS = { d1: 220, h4: 40, h1: 10, primary: 3 };

async function main() {
  const { getBacktestAccount, loadHistoricalRange, loadSymbolSpecs } = await import("./lib/market/backtest/historyLoader");
  const { runBacktest } = await import("./lib/market/backtest/backtestEngine");
  const { applyEarlyInvalidation } = await import("./lib/market/backtest/backtestInvalidation");
  const { toJournalEntries, DEFAULT_HYPOTHETICAL_EQUITY } = await import("./lib/market/backtest/backtestStats");
  const { getPerformanceStats } = await import("./lib/market/tradeJournal");
  const { evaluateSignal } = await import("./lib/market/signalEngine");
  const { loadExecutionConfig } = await import("./lib/market/executionConfig");
  const { DEFAULT_REALISTIC_SPREAD_FRACTION } = await import("./lib/market/backtest/constants");
  const { PAIRS } = await import("./lib/market/types");
  type Pair = (typeof PAIRS)[number];
  type Timeframe = "15m" | "30m" | "1h";

  const timeframe = (process.argv[2] ?? "15m") as Timeframe;
  const lookbackDays = Number(process.argv[3] ?? 60);
  const pairsArg = process.argv[4];
  // Pass "realistic" as a 5th arg to simulate real spread cost + break-even/trailing/
  // partial-close position management and real lot-size-based sizing (see
  // backtestEngine.ts's simulateRealisticOutcome) instead of the idealized fixed
  // SL-vs-TP1 outcome -- closer to what would actually happen live, at the cost of one
  // extra RPC connection (loadSymbolSpecs) per run.
  const realisticFlag = process.argv[5] === "realistic";
  const pairs = (pairsArg ? (pairsArg.split(",") as Pair[]) : (["BTC/USD"] as Pair[])).filter((p) => PAIRS.includes(p));
  if (pairs.length === 0) {
    console.error("no valid pairs given");
    process.exit(1);
  }

  const variants: { name: string; overrides?: { atrAverageMultiplier?: number; minAdx?: number } }[] = [
    { name: "baseline (today's live gates: ADX>=20, ATR>average)" },
    { name: "ATR gate loosened to 0.8x average (ADX unchanged)", overrides: { atrAverageMultiplier: 0.8 } },
    { name: "ATR gate loosened to 0.6x average (ADX unchanged)", overrides: { atrAverageMultiplier: 0.6 } },
    { name: "ADX floor lowered to 15 (ATR unchanged)", overrides: { minAdx: 15 } },
    { name: "both loosened (ATR 0.8x, ADX 15)", overrides: { atrAverageMultiplier: 0.8, minAdx: 15 } },
  ];

  console.error(`loading history for ${pairs.join(", ")} @ ${timeframe}, ${lookbackDays}d lookback...`);
  const account = await getBacktestAccount();
  const windowEnd = Date.now();
  const windowStart = windowEnd - lookbackDays * DAY_MS;

  // Fetched ONCE per pair, reused across every variant below -- identical inputs across
  // variants is what makes this comparison apples-to-apples (only the gate logic
  // differs, never the underlying candles).
  const seriesByPair = new Map<Pair, { primary: unknown[]; h1: unknown[]; h4: unknown[]; d1: unknown[] }>();
  for (const pair of pairs) {
    const primary = await loadHistoricalRange(account, pair, timeframe, new Date(windowStart - LEAD_IN_DAYS.primary * DAY_MS), new Date(windowEnd));
    const h1 = await loadHistoricalRange(account, pair, "1h", new Date(windowStart - LEAD_IN_DAYS.h1 * DAY_MS), new Date(windowEnd));
    const h4 = await loadHistoricalRange(account, pair, "4h", new Date(windowStart - LEAD_IN_DAYS.h4 * DAY_MS), new Date(windowEnd));
    const d1 = await loadHistoricalRange(account, pair, "1d", new Date(windowStart - LEAD_IN_DAYS.d1 * DAY_MS), new Date(windowEnd));
    seriesByPair.set(pair, { primary, h1, h4, d1 });
    console.error(`  ${pair}: ${primary.length} ${timeframe} bars loaded`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realisticSim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realisticSizing: any;
  if (realisticFlag) {
    console.error("fetching real symbol specs for realistic sim...");
    const liveConfig = loadExecutionConfig("live");
    const specs = await loadSymbolSpecs(account, pairs);
    realisticSim = {
      positionManagement: {
        breakEvenTriggerR: liveConfig.breakEvenTriggerR,
        trailingArmTriggerR: liveConfig.trailingArmTriggerR,
        trailingDistanceFractionOfStop: liveConfig.trailingDistanceFractionOfStop,
        partialCloseEnabled: liveConfig.partialCloseEnabled,
      },
      partialCloseFraction: liveConfig.partialCloseFraction,
      spreadFractionOfStop: DEFAULT_REALISTIC_SPREAD_FRACTION,
      specs,
    };
    realisticSizing = { specs, equity: DEFAULT_HYPOTHETICAL_EQUITY, riskPct: liveConfig.riskPerTradePct };
  }

  console.log(`\nTimeframe: ${timeframe}  Lookback: ${lookbackDays}d  Pairs: ${pairs.join(", ")}  Realistic: ${realisticFlag}`);
  console.log("(profit is a hypothetical $100-risk-per-trade figure -- only useful for RELATIVE comparison across rows, not a real P&L)\n");
  console.log(
    "variant".padEnd(48) +
      "trades".padStart(8) +
      "openAtEnd".padStart(11) +
      "winRate".padStart(10) +
      "avgR".padStart(8) +
      "profitFactor".padStart(14) +
      "maxDDR".padStart(9)
  );
  console.log("-".repeat(48 + 8 + 11 + 10 + 8 + 14 + 9));

  for (const variant of variants) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic-import-derived types across the loop body are not worth threading precisely for a throwaway script
    const evaluate: any = variant.overrides
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (candles: any, pair: any, tf: any, htf: any, overrides: any) => evaluateSignal(candles, pair, tf, htf, { ...overrides, ...variant.overrides })
      : undefined;

    const allResults: Awaited<ReturnType<typeof runBacktest>> = [];
    for (const pair of pairs) {
      const s = seriesByPair.get(pair)!;
      const raw = runBacktest({
        pair,
        timeframe,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        primary: s.primary as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h1: s.h1 as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h4: s.h4 as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        d1: s.d1 as any,
        windowStart,
        windowEnd,
        evaluate,
        realistic: realisticSim,
      });
      allResults.push(...applyEarlyInvalidation(raw));
    }

    const converted = toJournalEntries(allResults, undefined, realisticSizing);
    const stats = getPerformanceStats(converted.entries);
    const pf = stats.profitFactor === null ? "n/a" : stats.profitFactor.toFixed(2);
    const avgR = stats.averageR === null ? "n/a" : stats.averageR.toFixed(2);
    const maxDD = stats.maxDrawdownR === null ? "n/a" : stats.maxDrawdownR.toFixed(2);

    console.log(
      variant.name.padEnd(48) +
        String(stats.count).padStart(8) +
        String(converted.openAtWindowEnd).padStart(11) +
        `${stats.winRate.toFixed(1)}%`.padStart(10) +
        avgR.padStart(8) +
        pf.padStart(14) +
        maxDD.padStart(9)
    );
  }

  console.log("\ndone.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
