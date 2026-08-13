import { PAIRS, type AccountKey, type MarketRegime, type Pair, type Session, type Timeframe } from "@/lib/market/types";
import { getPerformanceStats, tradeJournal, type PerformanceFilter } from "@/lib/market/tradeJournal";
import { getOpenPositions, isAccountConfigured } from "@/lib/market/metaApiConnection";

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

  return Response.json({ entries, stats: getPerformanceStats(entries, filter), openCount: openPositionCount() });
}
