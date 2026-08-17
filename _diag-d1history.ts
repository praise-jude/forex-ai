import { config } from "dotenv";
config({ path: "./.env.local" });

async function main() {
  const { getBacktestAccount, loadHistoricalRange } = await import("./lib/market/backtest/historyLoader.ts");

  const account = await getBacktestAccount();
  const now = new Date();
  const twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);

  for (const pair of ["EUR/USD", "BTC/USD"] as const) {
    console.error(`[${new Date().toISOString()}] fetching 2y of D1 for ${pair}...`);
    const d1 = await loadHistoricalRange(account, pair, "1d", twoYearsAgo, now);
    console.log(`${pair}: got ${d1.length} D1 candles. earliest=${d1[0] ? new Date(d1[0].time).toISOString() : "none"} latest=${d1[d1.length - 1] ? new Date(d1[d1.length - 1].time).toISOString() : "none"}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
