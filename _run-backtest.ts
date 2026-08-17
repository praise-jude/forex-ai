import { config } from "dotenv";
config({ path: "./.env.local" });

async function main() {
  const { backtestRunner, DEFAULT_LOOKBACK_DAYS } = await import("./lib/market/backtest/backtestRunner");
  const { PAIRS } = await import("./lib/market/types");

  const job = backtestRunner.start({
    pairs: PAIRS,
    timeframe: "15m",
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    realistic: true,
  });

  if (!("id" in job)) {
    console.error("START ERROR:", job.error);
    process.exit(1);
  }
  console.error(`started job ${job.id}`);

  for (;;) {
    const status = backtestRunner.status();
    if (!status) {
      console.error("job vanished from memory");
      process.exit(1);
    }
    console.error(`[${new Date().toISOString()}] status=${status.status} pairs=${status.progress.pairsDone}/${status.progress.pairsTotal} bars=${status.progress.barsEvaluated}/${status.progress.barsTotal}`);
    if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
      console.log("===RESULT_JSON_START===");
      console.log(JSON.stringify(status, null, 2));
      console.log("===RESULT_JSON_END===");
      break;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
