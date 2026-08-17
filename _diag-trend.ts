import { config } from "dotenv";
config({ path: "./.env.local" });

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_IN_DAYS = { d1: 220, h4: 40, h1: 10, primary: 3 };
const LOOKBACK_DAYS = 60;
const TIMEFRAME = "15m" as const;

async function main() {
  const { getBacktestAccount, loadHistoricalRange } = await import("./lib/market/backtest/historyLoader.ts");
  const { runBacktest } = await import("./lib/market/backtest/backtestEngine.ts");
  const { PAIRS } = await import("./lib/market/types.ts");

  const account = await getBacktestAccount();
  const windowEnd = Date.now();
  const windowStart = windowEnd - LOOKBACK_DAYS * DAY_MS;

  let allThreeAgreeWithEachOther = 0;
  let allThreeAgreeAndMatchImplied = 0;
  let d1h4h1Disagree = 0;
  let d1Neutral = 0;
  const sampleRows: string[] = [];

  for (const pair of PAIRS) {
    console.error(`[${new Date().toISOString()}] fetching ${pair}...`);
    const primary = await loadHistoricalRange(account, pair, TIMEFRAME, new Date(windowStart - LEAD_IN_DAYS.primary * DAY_MS), new Date(windowEnd));
    const h1 = await loadHistoricalRange(account, pair, "1h", new Date(windowStart - LEAD_IN_DAYS.h1 * DAY_MS), new Date(windowEnd));
    const h4 = await loadHistoricalRange(account, pair, "4h", new Date(windowStart - LEAD_IN_DAYS.h4 * DAY_MS), new Date(windowEnd));
    const d1 = await loadHistoricalRange(account, pair, "1d", new Date(windowStart - LEAD_IN_DAYS.d1 * DAY_MS), new Date(windowEnd));

    const results = runBacktest({ pair, timeframe: TIMEFRAME, primary, h1, h4, d1, windowStart, windowEnd });

    for (const r of results) {
      if (r.evaluation.status !== "no_trade" || r.evaluation.reason.code !== "trend_disagreement") continue;
      const reason = r.evaluation.reason;
      if (reason.d1 === "neutral") {
        d1Neutral++;
        continue;
      }
      if (reason.d1 === reason.h4 && reason.h4 === reason.h1) {
        allThreeAgreeWithEachOther++;
        const implied = reason.impliedDirection === "long" ? "bullish" : "bearish";
        if (reason.d1 === implied) {
          allThreeAgreeAndMatchImplied++;
        } else if (sampleRows.length < 5) {
          sampleRows.push(`${pair}: d1=h4=h1=${reason.d1}, implied=${implied} (counter-trend sweep, correctly held)`);
        }
      } else {
        d1h4h1Disagree++;
        if (sampleRows.length < 10) sampleRows.push(`${pair}: d1=${reason.d1} h4=${reason.h4} h1=${reason.h1}, implied=${reason.impliedDirection}`);
      }
    }
    console.error(`[${new Date().toISOString()}] ${pair} done`);
  }

  console.log("===TREND_DIAG_START===");
  console.log(
    JSON.stringify(
      {
        d1Neutral,
        d1h4h1Disagree,
        allThreeAgreeWithEachOther,
        allThreeAgreeAndMatchImplied_shouldHaveFiredButDidnt: allThreeAgreeAndMatchImplied,
        sampleRows,
      },
      null,
      2
    )
  );
  console.log("===TREND_DIAG_END===");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
