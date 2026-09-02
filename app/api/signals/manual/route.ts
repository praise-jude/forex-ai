import { PAIRS, type Pair } from "@/lib/market/types";
import { candleStore } from "@/lib/market/candleStore";
import { priceStore } from "@/lib/market/priceStore";
import { buildManualSignal } from "@/lib/market/manualSignal";
import { publishSignal } from "@/lib/market/signalPublisher";
import { tradeJournal } from "@/lib/market/tradeJournal";
import { scoreSetupQuality } from "@/lib/market/setupQualityScore";
import { detectMarketRegime } from "@/lib/market/marketRegime";
import { calculateAdx } from "@/lib/market/indicators/adx";
import { calculateAtr } from "@/lib/market/indicators/atr";
import { checkNews } from "@/lib/market/newsFilter";

export const runtime = "nodejs";

function isPair(value: unknown): value is Pair {
  return typeof value === "string" && PAIRS.includes(value as Pair);
}

interface ManualTradeRequestBody {
  pair?: string;
  direction?: string;
  stopLoss?: number;
  takeProfit?: number;
  takeProfit2?: number;
}

/**
 * Registers a hand-entered trade (pair/direction/SL/TP the operator chose directly, not
 * detected by the SMC/range engines) as a real, tracked signal -- journaled and visible
 * exactly like an algorithm-detected one. A deliberately separate step from execution,
 * same reasoning as /api/signals/evaluate/publish: this only builds and registers the
 * signal; the client then calls the exact same /api/signals/{id}/execute route (and all
 * its risk checks -- sizing, correlation, daily-loss, spread, price-drift) every other
 * signal uses. No shortcut execution path exists here, and this can never auto-fire on
 * its own -- autoExecutionListener.ts only reacts to source "smc"/"mean_reversion".
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as ManualTradeRequestBody | null;
  const pair = body?.pair;
  const direction = body?.direction;

  if (!isPair(pair)) {
    return Response.json({ error: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (direction !== "long" && direction !== "short") {
    return Response.json({ error: 'direction must be "long" or "short"' }, { status: 400 });
  }
  if (typeof body?.stopLoss !== "number" || typeof body?.takeProfit !== "number") {
    return Response.json({ error: "stopLoss and takeProfit are required numbers" }, { status: 400 });
  }

  const price = priceStore.get(pair);
  if (!price) {
    return Response.json({ error: "no live price available for this pair yet -- try again shortly" }, { status: 400 });
  }
  // The real market-order fill side -- a manual trade fills at the current price, never
  // at a price the operator types in (see manualSignal.ts's own doc comment).
  const entry = direction === "long" ? price.ask : price.bid;

  const built = buildManualSignal(
    { pair, direction, entry, stopLoss: body.stopLoss, takeProfit: body.takeProfit, takeProfit2: body.takeProfit2 },
    Date.now()
  );
  if ("error" in built) {
    return Response.json({ error: built.error }, { status: 400 });
  }
  const { signal } = built;

  // Same "register as a real, tracked signal before executing it" step
  // app/api/signals/test-trade/route.ts and .../evaluate/publish/route.ts already do --
  // journaled and visible in the trade journal like any other signal, clearly labeled by
  // source (see UNSCORED_SOURCE_LABEL in types.ts) so it's never confused with a genuine
  // SMC/range read.
  const candles = candleStore.get(pair, signal.timeframe);
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
    source: signal.source,
  });

  return Response.json({ signal });
}
