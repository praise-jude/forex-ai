import { PAIRS, type AccountKey } from "@/lib/market/types";
import {
  getAccountInformation,
  getConnectionStatus,
  getSymbolSpecification,
  getSymbolTradingInfo,
  isAccountConfigured,
} from "@/lib/market/metaApiConnection";
import { priceStore } from "@/lib/market/priceStore";
import { isPriceStale } from "@/lib/market/marketHealth";

export const runtime = "nodejs";

function healthFor(accountKey: AccountKey) {
  const now = Date.now();
  return {
    account: accountKey,
    connectionStatus: getConnectionStatus(accountKey),
    accountInfo: getAccountInformation(accountKey) ?? null,
    pairs: PAIRS.map((pair) => {
      const spec = getSymbolSpecification(pair, accountKey);
      const tradingInfo = getSymbolTradingInfo(pair, accountKey);
      const price = priceStore.get(pair);
      return {
        pair,
        specAvailable: spec !== undefined,
        tradeMode: tradingInfo?.tradeMode ?? null,
        stopsLevel: tradingInfo?.stopsLevel ?? null,
        priceAvailable: price !== undefined,
        stale: isPriceStale(price, now),
      };
    }),
  };
}

// All synchronous, in-memory reads against the persistent connection's already-cached
// terminalState -- no network round-trip to MetaApi happens on this request, so it's
// fine to poll frequently (see SystemHealthPanel.tsx).
export async function GET() {
  return Response.json({
    live: healthFor("live"),
    demo: isAccountConfigured("demo") ? healthFor("demo") : null,
  });
}
