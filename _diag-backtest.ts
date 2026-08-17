import { config } from "dotenv";
config({ path: "./.env.local" });

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_IN_DAYS = { d1: 220, h4: 40, h1: 10, primary: 3 };
const LOOKBACK_DAYS = 60;
const TIMEFRAME = "15m" as const;

async function main() {
  const { getBacktestAccount, loadHistoricalRange } = await import("./lib/market/backtest/historyLoader");
  const { runBacktest } = await import("./lib/market/backtest/backtestEngine");
  const { PAIRS } = await import("./lib/market/types");

  const account = await getBacktestAccount();
  const windowEnd = Date.now();
  const windowStart = windowEnd - LOOKBACK_DAYS * DAY_MS;

  const tally: Record<string, number> = {};
  let totalBars = 0;
  let totalSignals = 0;
  const perPairSweepCounts: Record<string, number> = {};

  for (const pair of PAIRS) {
    console.error(`[${new Date().toISOString()}] fetching ${pair}...`);
    const primary = await loadHistoricalRange(account, pair, TIMEFRAME, new Date(windowStart - LEAD_IN_DAYS.primary * DAY_MS), new Date(windowEnd));
    const h1 = await loadHistoricalRange(account, pair, "1h", new Date(windowStart - LEAD_IN_DAYS.h1 * DAY_MS), new Date(windowEnd));
    const h4 = await loadHistoricalRange(account, pair, "4h", new Date(windowStart - LEAD_IN_DAYS.h4 * DAY_MS), new Date(windowEnd));
    const d1 = await loadHistoricalRange(account, pair, "1d", new Date(windowStart - LEAD_IN_DAYS.d1 * DAY_MS), new Date(windowEnd));

    console.error(`[${new Date().toISOString()}] ${pair}: primary=${primary.length} h1=${h1.length} h4=${h4.length} d1=${d1.length} -- replaying...`);

    const results = runBacktest({ pair, timeframe: TIMEFRAME, primary, h1, h4, d1, windowStart, windowEnd });

    let pairNoSetup = 0;
    for (const r of results) {
      totalBars++;
      if (r.evaluation.status === "signal") {
        totalSignals++;
        tally["SIGNAL_FIRED"] = (tally["SIGNAL_FIRED"] ?? 0) + 1;
      } else {
        const code = r.evaluation.reason.code;
        tally[code] = (tally[code] ?? 0) + 1;
        if (code === "no_setup") pairNoSetup++;
      }
    }
    perPairSweepCounts[pair] = results.length - pairNoSetup;
    console.error(`[${new Date().toISOString()}] ${pair} done: ${results.length} bars evaluated`);
  }

  console.log("===DIAG_RESULT_START===");
  console.log(JSON.stringify({ totalBars, totalSignals, tally, perPairNonNoSetupBars: perPairSweepCounts }, null, 2));
  console.log("===DIAG_RESULT_END===");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
