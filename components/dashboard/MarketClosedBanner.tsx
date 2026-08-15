"use client";

import { useEffect, useState } from "react";
import { PAIRS } from "@/lib/market/types";
import { isCrypto } from "@/lib/market/symbols";
import { isMarketClosed } from "@/lib/market/marketHours";

const NON_CRYPTO_PAIRS = PAIRS.filter((pair) => !isCrypto(pair));
const REFRESH_MS = 60_000;

// Ticks its own "now" on a 60s interval rather than depending on a live price tick --
// the weekend close/open boundary doesn't need finer precision than that, and this way
// the banner still appears/disappears correctly even if the tab is left open with no
// price events at all, which is exactly the situation this banner exists to explain.
export function MarketClosedBanner() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const allClosed = NON_CRYPTO_PAIRS.every((pair) => isMarketClosed(pair, now));
  if (!allClosed) return null;

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      <span className="font-semibold">Markets closed for the weekend.</span> Forex, metals, and oil reopen Sunday
      around 5pm New York time — only BTC/USD keeps trading until then.
    </div>
  );
}
