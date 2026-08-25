import { PAIRS, type MarketRegime, type Signal } from "@/lib/market/types";
import { publishSignal } from "@/lib/market/signalPublisher";
import { tradeJournal } from "@/lib/market/tradeJournal";
import { scoreSetupQuality } from "@/lib/market/setupQualityScore";

export const runtime = "nodejs";

const VALID_REGIMES: MarketRegime[] = [
  "news_driven",
  "breakout",
  "strong_uptrend",
  "strong_downtrend",
  "high_volatility",
  "low_volatility",
  "consolidation",
  "range",
];

interface PublishRequestBody {
  signal?: Signal;
  regime?: MarketRegime;
}

function isPlausibleSignal(value: unknown): value is Signal {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<Signal>;
  return (
    typeof s.id === "string" &&
    typeof s.pair === "string" &&
    PAIRS.includes(s.pair) &&
    (s.direction === "long" || s.direction === "short") &&
    typeof s.entry === "number" &&
    typeof s.stopLoss === "number" &&
    typeof s.takeProfit === "number" &&
    typeof s.createdAt === "number"
  );
}

/**
 * Turns an on-demand /api/signals/evaluate result (status "signal") into a real, tracked
 * signal -- registered in signalStore, journaled, and push-notified -- exactly like a
 * signal the live engine detects on its own. Deliberately a SEPARATE step from
 * evaluate itself: evaluate is called on every "Analyze" click and must stay side-effect
 * free, or just checking a pair would spam notifications and clutter Active Signals.
 * This only runs when the operator explicitly clicks "Place Trade" on a qualifying
 * result. Once published, execution goes through the exact same
 * /api/signals/{id}/execute route (and all its risk checks) every other signal uses --
 * no separate/shortcut execution path exists for on-demand signals.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as PublishRequestBody | null;
  const signal = body?.signal;
  const regime = body?.regime;

  if (!isPlausibleSignal(signal) || !regime || !VALID_REGIMES.includes(regime)) {
    return Response.json({ error: "invalid signal or regime" }, { status: 400 });
  }

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

  return Response.json({ id: signal.id });
}
