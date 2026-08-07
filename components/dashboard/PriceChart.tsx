"use client";

import { useCallback, useEffect, useRef } from "react";
import { CandlestickSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle, Pair, StreamEvent, Timeframe } from "@/lib/market/types";
import { decimals } from "@/lib/market/symbols";

interface PriceChartProps {
  pair: Pair;
  timeframe: Timeframe;
  streamEvent: StreamEvent | null;
}

const UP_COLOR = "#34d399";
const DOWN_COLOR = "#f87171";

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

export function PriceChart({ pair, timeframe, streamEvent }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candlesRef = useRef<Candle[]>([]);

  const renderAll = useCallback((candles: Candle[]) => {
    seriesRef.current?.setData(candles.map(toBar));
  }, []);

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

    chartRef.current = chart;
    seriesRef.current = candle;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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
      })
      .catch(() => {
        // Best-effort: an empty chart is an acceptable fallback if the fetch fails.
      });

    return () => {
      cancelled = true;
    };
  }, [pair, timeframe, renderAll]);

  // Apply live candle updates for the currently selected pair/timeframe.
  useEffect(() => {
    if (!streamEvent || streamEvent.type !== "candle") return;
    if (streamEvent.pair !== pair || streamEvent.timeframe !== timeframe) return;
    candlesRef.current = upsertCandle(candlesRef.current, streamEvent.candle);
    renderAll(candlesRef.current);
  }, [streamEvent, pair, timeframe, renderAll]);

  return <div ref={containerRef} className="h-full w-full" />;
}
