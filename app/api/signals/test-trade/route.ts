import { PAIRS, type Pair } from "@/lib/market/types";
import { candleStore } from "@/lib/market/candleStore";
import { priceStore } from "@/lib/market/priceStore";
import { buildManualTestSignal } from "@/lib/market/testTrade";
import { attemptExecution } from "@/lib/market/executionEngine";
import { isAccountConfigured } from "@/lib/market/metaApiConnection";
import { publishSignal } from "@/lib/market/signalPublisher";
import { tradeJournal } from "@/lib/market/tradeJournal";
import { scoreSetupQuality } from "@/lib/market/setupQualityScore";
import { detectMarketRegime } from "@/lib/market/marketRegime";
import { calculateAdx } from "@/lib/market/indicators/adx";
import { calculateAtr } from "@/lib/market/indicators/atr";
import { checkNews } from "@/lib/market/newsFilter";

export const runtime = "nodejs";

const TIMEFRAME = "15m" as const;

function isPair(value: unknown): value is Pair {
  return typeof value === "string" && PAIRS.includes(value as Pair);
}

interface TestTradeRequestBody {
  pair?: string;
  direction?: string;
}

/**
 * Places a deliberately synthetic order on the DEMO account, ALWAYS -- regardless of the
 * account's current engine mode (analysis/demo/live). Every other manual execution path
 * in this app resolves its target account via manualExecutionAccount(getEngineMode()) (see
 * app/api/signals/[id]/execute/route.ts) because a manual Buy/Sell click is meant to
 * follow whatever mode the operator has selected. This route has no such reason to exist
 * -- it's a standing diagnostic for "does DEMO order placement actually work right now"
 * (broker connectivity, symbol specs, sizing, the real order call, journaling), completely
 * independent of whether the real SMC/range engines currently find a qualifying setup, or
 * of whatever the dashboard's mode selector happens to be set to -- so it is hardcoded to
 * "demo" rather than reading engine mode at all, and can never be pointed at LIVE by a
 * mode mismatch.
 *
 * Still goes through attemptExecution's full, unmodified risk-checked path -- sizing,
 * correlation, spread, daily loss, execution policy, everything a real signal would face.
 * The only thing this bypasses is signalEngine.ts/rangeEngine.ts's own requirement that a
 * genuine setup exist first; it is not a shortcut around any risk or policy check.
 */
export async function POST(request: Request) {
  if (!isAccountConfigured("demo")) {
    return Response.json(
      { status: "blocked", code: "no_account", reason: "demo account is not configured (missing METAAPI_DEMO_TOKEN/METAAPI_DEMO_ACCOUNT_ID)" },
      { status: 400 }
    );
  }

  const body = (await request.json().catch(() => null)) as TestTradeRequestBody | null;
  const pair = body?.pair;
  const direction = body?.direction;

  if (!isPair(pair)) {
    return Response.json({ error: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (direction !== "long" && direction !== "short") {
    return Response.json({ error: 'direction must be "long" or "short"' }, { status: 400 });
  }

  const candles = candleStore.get(pair, TIMEFRAME);
  const price = priceStore.get(pair);
  const built = buildManualTestSignal(pair, direction, TIMEFRAME, candles, price);
  if (!built.ok) {
    return Response.json({ status: "blocked", code: "test_trade_unavailable", reason: built.reason }, { status: 400 });
  }

  const { signal } = built;

  // Same "register as a real, tracked signal before executing it" step
  // app/api/signals/evaluate/publish/route.ts already does for on-demand signals --
  // journaled and visible in the trade journal like any other signal, just clearly
  // labeled by source (see UNSCORED_SOURCE_LABEL in types.ts) so it's never confused with
  // a genuine SMC/range read.
  const regime = detectMarketRegime(candles, calculateAdx(candles), calculateAtr(candles), checkNews(pair, Date.now()));
  publishSignal(signal);
  tradeJournal.recordSignalContext({
    signalId: signal.id,
    pair: signal.pair,
    timeframe: signal.timeframe,
    direction: signal.direction,
    regime,
    setupQuality: scoreSetupQuality(signal, regime),
    confidence: signal.confidence,
    signerBDirection: signal.signerBDirection,
    signerBConfidence: signal.signerBConfidence,
    adx: signal.adx,
    rsi: signal.rsi,
    newsStatus: signal.newsStatus,
    session: signal.session,
    createdAt: signal.createdAt,
    confluences: signal.confluences,
  });

  const result = await attemptExecution(signal, "demo");
  return Response.json(result);
}
