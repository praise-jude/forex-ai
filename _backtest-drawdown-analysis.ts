// Digs into the max-drawdown finding from _backtest-gate-comparison.ts's trend-agreement
// test: the "d1_or_h4" variant showed a much higher max drawdown (22.95R vs baseline's
// 3.99R) alongside much better averages. This prints the ACTUAL sequence of trades inside
// that drawdown window, sorted in true chronological order across all pairs (the
// comparison script's own maxDrawdownR sums entries pair-by-pair, not time-interleaved --
// this fixes that for a real answer to "what did the losing stretch actually look like").
import { config } from "dotenv";
config({ path: "./.env.local" });

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_IN_DAYS = { d1: 220, h4: 40, h1: 10, primary: 3 };

async function main() {
  const { getBacktestAccount, loadHistoricalRange } = await import("./lib/market/backtest/historyLoader");
  const { runBacktest } = await import("./lib/market/backtest/backtestEngine");
  const { applyEarlyInvalidation } = await import("./lib/market/backtest/backtestInvalidation");
  const { toJournalEntries } = await import("./lib/market/backtest/backtestStats");
  const { evaluateSignal } = await import("./lib/market/signalEngine");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used for the Pair type derivation below only
  const { PAIRS } = await import("./lib/market/types");
  type Pair = (typeof PAIRS)[number];
  type Timeframe = "15m" | "30m" | "1h";

  const timeframe: Timeframe = "15m";
  const lookbackDays = 180;
  const pairs = ["GBP/USD", "XAU/USD", "BTC/USD", "USOIL", "ETH/USD"] as Pair[];

  console.error(`loading history for ${pairs.join(", ")} @ ${timeframe}, ${lookbackDays}d lookback...`);
  const account = await getBacktestAccount();
  const windowEnd = Date.now();
  const windowStart = windowEnd - lookbackDays * DAY_MS;

  const allResults: Awaited<ReturnType<typeof runBacktest>> = [];
  for (const pair of pairs) {
    const primary = await loadHistoricalRange(account, pair, timeframe, new Date(windowStart - LEAD_IN_DAYS.primary * DAY_MS), new Date(windowEnd));
    const h1 = await loadHistoricalRange(account, pair, "1h", new Date(windowStart - LEAD_IN_DAYS.h1 * DAY_MS), new Date(windowEnd));
    const h4 = await loadHistoricalRange(account, pair, "4h", new Date(windowStart - LEAD_IN_DAYS.h4 * DAY_MS), new Date(windowEnd));
    const d1 = await loadHistoricalRange(account, pair, "1d", new Date(windowStart - LEAD_IN_DAYS.d1 * DAY_MS), new Date(windowEnd));
    console.error(`  ${pair}: ${primary.length} bars`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evaluate: any = (candles: any, p: any, tf: any, htf: any, overrides: any) =>
      evaluateSignal(candles, p, tf, htf, { ...overrides, trendAgreementMode: "d1_or_h4" });

    const raw = runBacktest({ pair, timeframe, primary, h1, h4, d1, windowStart, windowEnd, evaluate });
    allResults.push(...applyEarlyInvalidation(raw));
  }

  const converted = toJournalEntries(allResults);
  // True chronological order across ALL pairs -- the comparison script's own
  // maxDrawdownR effectively processes one pair's full history, then the next, which
  // isn't a real shared equity curve. This is.
  const entries = [...converted.entries].sort((a, b) => a.closedAt - b.closedAt);

  console.log(`\nTotal closed trades (chronological, all pairs): ${entries.length}`);

  // Find the real peak-to-trough drawdown window over this properly time-sorted sequence.
  let cumulative = 0;
  let peak = 0;
  let peakIndex = 0;
  let maxDrop = 0;
  let dropStartIndex = 0;
  let dropEndIndex = 0;
  for (let i = 0; i < entries.length; i++) {
    const r = entries[i].rMultiple ?? 0;
    cumulative += r;
    if (cumulative > peak) {
      peak = cumulative;
      peakIndex = i;
    }
    const drop = peak - cumulative;
    if (drop > maxDrop) {
      maxDrop = drop;
      dropStartIndex = peakIndex;
      dropEndIndex = i;
    }
  }

  console.log(`\nReal (time-sorted, all-pairs) max drawdown: ${maxDrop.toFixed(2)}R, from trade #${dropStartIndex + 1} to #${dropEndIndex + 1}\n`);
  console.log("Trades inside that drawdown window:");
  console.log("date".padEnd(22) + "pair".padEnd(10) + "dir".padEnd(7) + "reason".padEnd(14) + "R".padStart(7));
  console.log("-".repeat(62));
  let running = 0;
  for (let i = dropStartIndex; i <= dropEndIndex; i++) {
    const e = entries[i];
    running += e.rMultiple ?? 0;
    console.log(
      new Date(e.closedAt).toISOString().slice(0, 16).replace("T", " ").padEnd(22) +
        e.pair.padEnd(10) +
        e.direction.padEnd(7) +
        e.reason.padEnd(14) +
        (e.rMultiple ?? 0).toFixed(2).padStart(7)
    );
  }
  console.log("-".repeat(62));
  console.log(`Cumulative R across this window: ${running.toFixed(2)}`);

  // A quick breakdown: how many losses in a row does this window actually contain, and
  // is it concentrated in one pair or spread across several?
  const pairCounts: Record<string, number> = {};
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (let i = dropStartIndex; i <= dropEndIndex; i++) {
    const e = entries[i];
    pairCounts[e.pair] = (pairCounts[e.pair] ?? 0) + 1;
    if ((e.rMultiple ?? 0) < 0) {
      consecutiveLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }
  console.log(`\nPairs involved in this window:`, pairCounts);
  console.log(`Longest losing streak within the window: ${maxConsecutiveLosses} in a row`);
  console.log(`\ndone.`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
