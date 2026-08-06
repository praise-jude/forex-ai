"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Pair, StreamEvent, Timeframe } from "@/lib/market/types";
import { decimals } from "@/lib/market/symbols";
import { calculateEma } from "@/lib/market/indicators/ema";
import { calculateRsi } from "@/lib/market/indicators/rsi";
import { calculateMacd } from "@/lib/market/indicators/macd";
import { calculateAdx } from "@/lib/market/indicators/adx";

interface PriceChartProps {
  pair: Pair;
  timeframe: Timeframe;
  streamEvent: StreamEvent | null;
}

const EMA_PERIODS = [20, 50, 100, 200] as const;
type EmaPeriod = (typeof EMA_PERIODS)[number];
const EMA_COLORS: Record<EmaPeriod, string> = { 20: "#fbbf24", 50: "#38bdf8", 100: "#a78bfa", 200: "#f472b6" };

// Mirrors the ADX pre-gate in signalEngine.ts (kept as a local constant rather than an
// import, since that module pulls in node:crypto and other server-only dependencies
// that can't be bundled into this client component).
const ADX_THRESHOLD = 20;

const UP_COLOR = "#34d399";
const DOWN_COLOR = "#f87171";

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function toBar(candle: Candle) {
  return { time: toTime(candle.time), open: candle.open, high: candle.high, low: candle.low, close: candle.close };
}

/** Drops NaN warm-up entries rather than plotting them, matching how every indicator here prefixes its output. */
function lineData(candles: Candle[], values: number[]): { time: UTCTimestamp; value: number }[] {
  const data: { time: UTCTimestamp; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(values[i])) continue;
    data.push({ time: toTime(candles[i].time), value: values[i] });
  }
  return data;
}

/**
 * Mirrors candleStore.upsert()'s ordering rules (append / same-bar update / late
 * correction to an earlier bar) so this client keeps an accurate, strictly-ascending
 * candle history to recompute indicators from on every live tick.
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

interface SeriesRefs {
  candle: ISeriesApi<"Candlestick">;
  ema: Record<EmaPeriod, ISeriesApi<"Line">>;
  volume: ISeriesApi<"Histogram">;
  rsi: ISeriesApi<"Line">;
  macd: ISeriesApi<"Line">;
  macdSignal: ISeriesApi<"Line">;
  macdHist: ISeriesApi<"Histogram">;
  adx: ISeriesApi<"Line">;
}

export function PriceChart({ pair, timeframe, streamEvent }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<SeriesRefs | null>(null);
  const candlesRef = useRef<Candle[]>([]);

  const renderAll = useCallback((candles: Candle[]) => {
    const series = seriesRef.current;
    if (!series) return;

    series.candle.setData(candles.map(toBar));

    const closes = candles.map((c) => c.close);
    for (const period of EMA_PERIODS) {
      series.ema[period].setData(lineData(candles, calculateEma(closes, period)));
    }

    series.volume.setData(
      candles.map((c) => ({
        time: toTime(c.time),
        value: c.tickVolume,
        color: c.close >= c.open ? "rgba(52, 211, 153, 0.5)" : "rgba(248, 113, 113, 0.5)",
      }))
    );

    series.rsi.setData(lineData(candles, calculateRsi(candles)));

    const { macdLine, signalLine } = calculateMacd(candles);
    series.macd.setData(lineData(candles, macdLine));
    series.macdSignal.setData(lineData(candles, signalLine));
    const macdHist: { time: UTCTimestamp; value: number; color: string }[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (Number.isNaN(macdLine[i]) || Number.isNaN(signalLine[i])) continue;
      const diff = macdLine[i] - signalLine[i];
      macdHist.push({
        time: toTime(candles[i].time),
        value: diff,
        color: diff >= 0 ? "rgba(52, 211, 153, 0.6)" : "rgba(248, 113, 113, 0.6)",
      });
    }
    series.macdHist.setData(macdHist);

    series.adx.setData(lineData(candles, calculateAdx(candles)));
  }, []);

  // Chart + series lifecycle: created once per mount. Panes: 0 price+EMA, 1 volume,
  // 2 RSI, 3 MACD, 4 ADX — every indicator the confidence-scoring engine checks.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#a1a1aa" },
      grid: { vertLines: { color: "#27272a" }, horzLines: { color: "#27272a" } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });

    const candle = chart.addSeries(
      CandlestickSeries,
      { upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR },
      0
    );

    const ema = {} as Record<EmaPeriod, ISeriesApi<"Line">>;
    for (const period of EMA_PERIODS) {
      ema[period] = chart.addSeries(
        LineSeries,
        { color: EMA_COLORS[period], lineWidth: 1, title: `EMA ${period}`, priceLineVisible: false, lastValueVisible: false },
        0
      );
    }

    const volume = chart.addSeries(HistogramSeries, { color: "#71717a", priceFormat: { type: "volume" }, title: "Volume" }, 1);

    const rsi = chart.addSeries(LineSeries, { color: "#22d3ee", lineWidth: 1, title: "RSI 14" }, 2);
    rsi.createPriceLine({ price: 70, color: "#52525b", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "70" });
    rsi.createPriceLine({ price: 30, color: "#52525b", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "30" });

    const macdHist = chart.addSeries(HistogramSeries, { title: "MACD hist", priceLineVisible: false, lastValueVisible: false }, 3);
    const macd = chart.addSeries(LineSeries, { color: "#60a5fa", lineWidth: 1, title: "MACD" }, 3);
    const macdSignal = chart.addSeries(LineSeries, { color: "#fb923c", lineWidth: 1, title: "Signal" }, 3);

    const adx = chart.addSeries(LineSeries, { color: "#c084fc", lineWidth: 1, title: "ADX 14" }, 4);
    adx.createPriceLine({
      price: ADX_THRESHOLD,
      color: "#52525b",
      lineStyle: 2,
      lineWidth: 1,
      axisLabelVisible: true,
      title: "trade min",
    });

    const stretchFactors = [4, 1, 1.3, 1.3, 1];
    chart.panes().forEach((pane, i) => pane.setStretchFactor(stretchFactors[i] ?? 1));

    chartRef.current = chart;
    seriesRef.current = { candle, ema, volume, rsi, macd, macdSignal, macdHist, adx };

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Reseed history whenever the selected pair or timeframe changes.
  useEffect(() => {
    let cancelled = false;

    seriesRef.current?.candle.applyOptions({
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

  // Apply live candle updates for the currently selected pair/timeframe. Every
  // indicator here is recursive/window-based, so a late correction to an earlier bar
  // (see candleStore.ts) can change every value downstream of it — cheap enough at
  // ~300 candles to just recompute and re-set every series rather than patch one point.
  useEffect(() => {
    if (!streamEvent || streamEvent.type !== "candle") return;
    if (streamEvent.pair !== pair || streamEvent.timeframe !== timeframe) return;
    candlesRef.current = upsertCandle(candlesRef.current, streamEvent.candle);
    renderAll(candlesRef.current);
  }, [streamEvent, pair, timeframe, renderAll]);

  return <div ref={containerRef} className="h-full w-full" />;
}
