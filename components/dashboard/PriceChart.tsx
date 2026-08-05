"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle, Pair, StreamEvent, Timeframe } from "@/lib/market/types";
import { decimals } from "@/lib/market/symbols";

interface PriceChartProps {
  pair: Pair;
  timeframe: Timeframe;
  streamEvent: StreamEvent | null;
}

function toBar(candle: Candle) {
  return {
    time: Math.floor(candle.time / 1000) as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

export function PriceChart({ pair, timeframe, streamEvent }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // Chart lifecycle: created once per mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#a1a1aa" },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f87171",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Reseed history whenever the selected pair or timeframe changes.
  useEffect(() => {
    let cancelled = false;

    seriesRef.current?.applyOptions({ priceFormat: { type: "price", precision: decimals(pair), minMove: 1 / 10 ** decimals(pair) } });

    fetch(`/api/candles?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`)
      .then((res) => res.json())
      .then((data: { candles: Candle[] }) => {
        if (cancelled) return;
        seriesRef.current?.setData(data.candles.map(toBar));
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {
        // Best-effort: an empty chart is an acceptable fallback if the fetch fails.
      });

    return () => {
      cancelled = true;
    };
  }, [pair, timeframe]);

  // Apply live candle updates for the currently selected pair/timeframe.
  useEffect(() => {
    if (!streamEvent || streamEvent.type !== "candle") return;
    if (streamEvent.pair !== pair || streamEvent.timeframe !== timeframe) return;
    seriesRef.current?.update(toBar(streamEvent.candle));
  }, [streamEvent, pair, timeframe]);

  return <div ref={containerRef} className="h-full w-full" />;
}
