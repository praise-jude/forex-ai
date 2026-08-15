import { PAIRS, type Pair, type Timeframe } from "@/lib/market/types";
import { BACKTEST_TIMEFRAMES, DEFAULT_LOOKBACK_DAYS, backtestRunner } from "@/lib/market/backtest/backtestRunner";

export const runtime = "nodejs";

function isPair(value: unknown): value is Pair {
  return typeof value === "string" && PAIRS.includes(value as Pair);
}

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && BACKTEST_TIMEFRAMES.includes(value as Timeframe);
}

export async function GET() {
  return Response.json({ current: backtestRunner.status(), history: backtestRunner.listHistory() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { pairs?: unknown; timeframe?: unknown; lookbackDays?: unknown; realistic?: unknown }
    | null;
  if (!body) {
    return Response.json({ error: "invalid_body", message: "Expected a JSON body." }, { status: 400 });
  }

  const pairs = Array.isArray(body.pairs) ? body.pairs.filter(isPair) : [];
  if (pairs.length === 0) {
    return Response.json({ error: "invalid_pairs", message: "pairs must be a non-empty array of configured pairs." }, { status: 400 });
  }
  if (!isTimeframe(body.timeframe)) {
    return Response.json(
      { error: "invalid_timeframe", message: `timeframe must be one of ${BACKTEST_TIMEFRAMES.join(", ")}` },
      { status: 400 }
    );
  }
  const lookbackDays = typeof body.lookbackDays === "number" && Number.isFinite(body.lookbackDays) ? body.lookbackDays : DEFAULT_LOOKBACK_DAYS;
  const realistic = body.realistic === true;

  const result = backtestRunner.start({ pairs, timeframe: body.timeframe, lookbackDays, realistic });
  // Checked via "status" (present on every real BacktestJob), not "error" -- a
  // BacktestJob itself also has an `error: string | null` field (its own job-level
  // failure reason), so "error" in result would have matched a successful job too.
  if (!("status" in result)) {
    return Response.json({ error: "cannot_start", message: result.error }, { status: 409 });
  }
  return Response.json(result);
}
