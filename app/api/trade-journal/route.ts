import { PAIRS, type AccountKey, type MarketRegime, type Pair, type Session, type Timeframe } from "@/lib/market/types";
import {
  defaultCalibrationMinSamples,
  getConfidenceCalibration,
  getConfluenceBreakdown,
  getPerformanceBreakdown,
  getPerformanceStats,
  getSignalFunnelStats,
  getSignerBCalibration,
  tradeJournal,
  type PerformanceFilter,
} from "@/lib/market/tradeJournal";
import { getOpenPositions, isAccountConfigured } from "@/lib/market/metaApiConnection";
import { positionStore } from "@/lib/market/positionStore";
import { getSlippageBreakdownByPair, getSlippagePoints, getSlippageStats } from "@/lib/market/slippage";

export const runtime = "nodejs";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];
const SESSIONS: Session[] = ["asia", "london", "newyork", "off-session"];
const REGIMES: MarketRegime[] = [
  "news_driven",
  "breakout",
  "strong_uptrend",
  "strong_downtrend",
  "high_volatility",
  "low_volatility",
  "consolidation",
  "range",
];

function isPair(value: string | null): value is Pair {
  return PAIRS.includes(value as Pair);
}

function isTimeframe(value: string | null): value is Timeframe {
  return TIMEFRAMES.includes(value as Timeframe);
}

function isSession(value: string | null): value is Session {
  return SESSIONS.includes(value as Session);
}

function isRegime(value: string | null): value is MarketRegime {
  return REGIMES.includes(value as MarketRegime);
}

// All filters are optional -- an unfiltered request returns the full ledger's stats,
// same as the dashboard's default /journal view.
function filterFromParams(searchParams: URLSearchParams): PerformanceFilter {
  const filter: PerformanceFilter = {};
  const pair = searchParams.get("pair");
  const timeframe = searchParams.get("timeframe");
  const session = searchParams.get("session");
  const regime = searchParams.get("regime");
  const signerBAgreement = searchParams.get("signerBAgreement");

  if (isPair(pair)) filter.pair = pair;
  if (isTimeframe(timeframe)) filter.timeframe = timeframe;
  if (isSession(session)) filter.session = session;
  if (isRegime(regime)) filter.regime = regime;
  if (signerBAgreement === "true") filter.signerBAgreement = true;
  if (signerBAgreement === "false") filter.signerBAgreement = false;

  return filter;
}

// Every currently open position, across whichever accounts are configured -- summed
// into the journal's own "Trades" count so it reflects every trade this app has ever
// taken, not just the ones that have already closed (win/loss/R stats below still stay
// closed-trades-only, since an open position has no final outcome yet to score).
function openPositionCount(): number {
  const accounts: AccountKey[] = ["live", ...(isAccountConfigured("demo") ? (["demo"] as const) : [])];
  return accounts.reduce((sum, accountKey) => sum + getOpenPositions(accountKey).length, 0);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filter = filterFromParams(searchParams);
  const entries = tradeJournal.all();
  const slippagePoints = getSlippagePoints(positionStore.all());

  return Response.json({
    entries,
    stats: getPerformanceStats(entries, filter),
    openCount: openPositionCount(),
    // Signal-decision funnel (approved/rejected/expired/blocked) -- distinct from
    // `stats` above, which only ever scores real closed trades. See getSignalFunnelStats
    // and SignalOutcome's own doc comment in tradeJournal.ts for why these are kept
    // separate ("AI signal performance" vs "actual executed trade performance").
    signalFunnel: getSignalFunnelStats(tradeJournal.allSignalOutcomes()),
    // "Which pairs/sessions is my performance actually coming from" -- always computed
    // over the full unfiltered ledger (ignores `filter` above, same as signalFunnel),
    // since the point is to compare buckets against each other, not view one pre-picked.
    breakdownByPair: getPerformanceBreakdown(entries, "pair"),
    breakdownBySession: getPerformanceBreakdown(entries, "session"),
    // "Which market regime is my SMC strategy actually working in" -- effectively
    // SMC-only, see getPerformanceBreakdown's own doc comment. Also always over the
    // full unfiltered ledger, same reasoning as the breakdowns above.
    breakdownByRegime: getPerformanceBreakdown(entries, "regime"),
    // "Which confluences actually predict wins" -- see getConfluenceBreakdown's own doc
    // comment. Also always over the full unfiltered ledger, same reasoning as above.
    breakdownByConfluence: getConfluenceBreakdown(entries),
    // "Is the broker filling me at a worse price than I asked for" -- sourced from
    // positionStore's execution ledger (requestedEntry/filledEntry), not tradeJournal --
    // a filled trade has real slippage the instant it fills, whether or not it has
    // closed yet, so this is a superset of (not scoped to) the closed-trade entries above.
    slippage: getSlippageStats(slippagePoints),
    slippageByPair: getSlippageBreakdownByPair(slippagePoints),
    // "Can I actually trust a 95% confidence signal" -- same measurement the web
    // /settings page already shows, now available to mobile too. calibrationMinSamples
    // is included alongside (not hardcoded client-side) so both platforms always agree
    // on the real threshold, including any CONFIDENCE_CALIBRATION_MIN_SAMPLES override.
    confidenceCalibration: getConfidenceCalibration(entries, defaultCalibrationMinSamples()),
    // "Is Signer B actually pulling its weight, or just rubber-stamping Signer A" --
    // see getSignerBCalibration's own doc comment. Shares the same min-samples
    // threshold as confidenceCalibration above, for a direct apples-to-apples scorecard.
    signerBCalibration: getSignerBCalibration(entries, defaultCalibrationMinSamples()),
    calibrationMinSamples: defaultCalibrationMinSamples(),
  });
}
