import type { Signal } from "./types";
import { signalStore } from "./signalStore";
import { eventBus } from "./eventBus";
import { sendNotification } from "./pushNotifier";
import { formatPrice } from "./format";

/**
 * The single funnel every newly-created signal passes through, regardless of origin (the
 * SMC engine off a closed M15 candle, or a TradingView webhook alert) -- records it,
 * broadcasts it to the dashboard's SSE stream, and pushes it to mobile devices. Having one
 * call site (instead of repeating these three steps at both origins) is what keeps mobile
 * push notifications from silently missing one signal source if a second one is ever added.
 */
export function publishSignal(signal: Signal): void {
  signalStore.add(signal);
  eventBus.publish({ type: "signal", signal });

  // Watch-tier never cleared the buy/strong_buy bar -- informational only on the
  // dashboard, and not worth interrupting a phone for either (matches the web
  // dashboard's own toast/voice-announce behavior in Dashboard.tsx).
  if (signal.tier === "watch") return;

  const directionLabel = signal.direction === "long" ? "BUY" : "SELL";
  void sendNotification({
    category: signal.direction === "long" ? "buy_signal" : "sell_signal",
    title: `JUDE AI — ${directionLabel} ${signal.pair}`,
    body: `${signal.timeframe} | Confidence ${signal.confidence.toFixed(0)}% | Entry ${formatPrice(signal.pair, signal.entry)} | SL ${formatPrice(signal.pair, signal.stopLoss)} | TP ${formatPrice(signal.pair, signal.takeProfit)}`,
    data: { signalId: signal.id, pair: signal.pair, direction: signal.direction },
    confidence: signal.confidence,
  });
}
