"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Pair, PredictionUpdate, StreamEvent, Timeframe } from "@/lib/market/types";
import { decimals } from "@/lib/market/symbols";

interface PriceChartProps {
  pair: Pair;
  timeframe: Timeframe;
  streamEvent: StreamEvent | null;
  /** The current pair/timeframe's real evaluation, for the entry/SL/TP/zone price-line
   * annotations and the AI forecast curve -- null while still loading, or when the
   * selected pair/timeframe don't match this update. */
  prediction: PredictionUpdate | null;
}

const UP_COLOR = "#34d399";
const DOWN_COLOR = "#f87171";
// Purely illustrative candle spacing for the forecast curve's TP1/TP2 points -- this
// has no relationship to a real time prediction (the engine makes no time-to-target
// estimate), it only visually separates the curve from the last close so it reads as
// "projected ahead" rather than overlapping the candles. Same spirit as
// signalEngine.ts's ATR_BUFFER_FRACTION-style tunable constants.
const FORECAST_BAR_SPACING = 8;

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function toBar(candle: Candle) {
  return { time: toTime(candle.time), open: candle.open, high: candle.high, low: candle.low, close: candle.close };
}

/**
 * Mirrors candleStore.upsert()'s ordering rules (append / same-bar update / late
 * correction to an earlier bar) so this client keeps an accurate, strictly-ascending
 * candle history for the chart to render.
 */
function upsertCandle(candles: Candle[], candle: Candle): Candle[] {
  const last = candles[candles.length - 1];
  if (!last || candle.time > last.time) return [...candles, candle];
  if (candle.time === last.time) return [...candles.slice(0, -1), candle];
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candles[i].time === candle.time) {
      const next = candles.slice();
      next[i] = candle;
      return next;
    }
    if (candles[i].time < candle.time) break;
  }
  return candles;
}

export function PriceChart({ pair, timeframe, streamEvent, prediction }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const forecastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const forecastLabelRef = useRef<HTMLDivElement>(null);

  const renderAll = useCallback((candles: Candle[]) => {
    seriesRef.current?.setData(candles.map(toBar));
  }, []);

  // Draws (or clears) the entry/SL/TP/zone price lines and the AI forecast curve for
  // the currently held `prediction` prop, against whatever candle history is currently
  // loaded. Never fabricates a curve for a no_trade evaluation -- there's no entry/TP
  // to derive one from.
  const redrawAnnotations = useCallback(() => {
    const series = seriesRef.current;
    const forecastSeries = forecastSeriesRef.current;
    if (!series || !forecastSeries) return;

    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    forecastSeries.setData([]);
    if (forecastLabelRef.current) forecastLabelRef.current.style.display = "none";

    if (!prediction || prediction.pair !== pair || prediction.timeframe !== timeframe) return;
    if (prediction.evaluation.status !== "signal") return;
    const signal = prediction.evaluation.signal;

    const addLine = (price: number, color: string, title: string) => {
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title })
      );
    };
    addLine(signal.entry, "#a1a1aa", "Entry");
    addLine(signal.stopLoss, DOWN_COLOR, "SL");
    addLine(signal.takeProfit, UP_COLOR, "TP1");
    addLine(signal.takeProfit2, UP_COLOR, "TP2");
    if (signal.zoneTop !== undefined) addLine(signal.zoneTop, "#60a5fa", "Zone");
    if (signal.zoneBottom !== undefined) addLine(signal.zoneBottom, "#60a5fa", "Zone");

    const lastCandle = candlesRef.current[candlesRef.current.length - 1];
    if (!lastCandle) return; // candles not loaded yet -- the history-reseed effect calls this again once they are

    const barMs = TIMEFRAME_MS[timeframe];
    forecastSeries.applyOptions({ color: signal.direction === "long" ? UP_COLOR : DOWN_COLOR });
    forecastSeries.setData([
      { time: toTime(lastCandle.time), value: lastCandle.close },
      { time: toTime(lastCandle.time + barMs * FORECAST_BAR_SPACING), value: signal.takeProfit },
      { time: toTime(lastCandle.time + barMs * FORECAST_BAR_SPACING * 2), value: signal.takeProfit2 },
    ]);
    if (forecastLabelRef.current) forecastLabelRef.current.style.display = "block";
  }, [prediction, pair, timeframe]);

  // Chart + series lifecycle: created once per mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#a1a1aa" },
      grid: { vertLines: { color: "#27272a" }, horzLines: { color: "#27272a" } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });

    // Low-opacity dotted line, distinct from the solid candle wicks, so it reads as
    // "illustrative" rather than real price action -- see the AI FORECAST label overlay.
    const forecast = chart.addSeries(LineSeries, {
      lineWidth: 2,
      lineStyle: LineStyle.Dotted,
      color: UP_COLOR,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = candle;
    forecastSeriesRef.current = forecast;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      forecastSeriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Reseed history whenever the selected pair or timeframe changes.
  useEffect(() => {
    let cancelled = false;

    seriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: decimals(pair), minMove: 1 / 10 ** decimals(pair) },
    });

    fetch(`/api/candles?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`)
      .then((res) => res.json())
      .then((data: { candles: Candle[] }) => {
        if (cancelled) return;
        candlesRef.current = data.candles;
        renderAll(data.candles);
        chartRef.current?.timeScale().fitContent();
        redrawAnnotations();
      })
      .catch(() => {
        // Best-effort: an empty chart is an acceptable fallback if the fetch fails.
      });

    return () => {
      cancelled = true;
    };
  }, [pair, timeframe, renderAll, redrawAnnotations]);

  // Apply live candle updates for the currently selected pair/timeframe.
  useEffect(() => {
    if (!streamEvent || streamEvent.type !== "candle") return;
    if (streamEvent.pair !== pair || streamEvent.timeframe !== timeframe) return;
    candlesRef.current = upsertCandle(candlesRef.current, streamEvent.candle);
    renderAll(candlesRef.current);
  }, [streamEvent, pair, timeframe, renderAll]);

  // Redraw annotations/forecast whenever the prediction itself changes (new evaluation
  // for this pair, or the user switched pairs -- redrawAnnotations already checks that
  // `prediction` actually matches the current pair/timeframe before drawing anything).
  useEffect(() => {
    redrawAnnotations();
  }, [redrawAnnotations]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div
        ref={forecastLabelRef}
        className="pointer-events-none absolute right-2 top-2 hidden rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-400"
      >
        AI FORECAST &middot; PROJECTED PATH (illustrative, not a price prediction)
      </div>
    </div>
  );
}
