"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type IRange,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Pair, PredictionUpdate, StreamEvent, Timeframe } from "@/lib/market/types";
import { decimals } from "@/lib/market/symbols";
import { TIMEFRAME_MS } from "@/lib/market/timeframes";

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
// Single neutral accent for the Line/Area chart types, which have no inherent per-bar
// up/down meaning the way Candlestick/Bar do -- matches TradingView's own convention of
// one line color rather than forcing red/green onto a line.
const LINE_COLOR = "#38bdf8";
// Purely illustrative candle spacing for the forecast curve's TP1/TP2 points -- this
// has no relationship to a real time prediction (the engine makes no time-to-target
// estimate), it only visually separates the curve from the last close so it reads as
// "projected ahead" rather than overlapping the candles. Same spirit as
// signalEngine.ts's ATR_BUFFER_FRACTION-style tunable constants.
const FORECAST_BAR_SPACING = 8;

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

const VISIBLE_RANGE_STORAGE_PREFIX = "forex-ai:chart-visible-range:";
const CHART_TYPE_STORAGE_KEY = "forex-ai:chart-type";

// Keyed per pair+timeframe (not a single global key) so switching between them doesn't
// clobber each other's zoom -- restored on refresh AND on switching back to a
// pair/timeframe already zoomed earlier in the session.
function visibleRangeStorageKey(pair: Pair, timeframe: Timeframe): string {
  return `${VISIBLE_RANGE_STORAGE_PREFIX}${pair}:${timeframe}`;
}

function safeParseRange(raw: string): IRange<Time> | null {
  try {
    const parsed = JSON.parse(raw) as IRange<Time>;
    return typeof parsed.from === "number" && typeof parsed.to === "number" ? parsed : null;
  } catch {
    return null;
  }
}

// TradingView's own four core chart types -- Candlestick and Bar both plot real OHLC,
// Line and Area both plot a single value (the close), same grouping as TradingView's.
// A single, GLOBAL preference (not per pair/timeframe) -- matches how a real trading
// platform's chart-type choice works: it's how you like to look at any chart, not a
// per-instrument setting.
export type ChartType = "candlestick" | "bar" | "line" | "area";
const CHART_TYPES: ChartType[] = ["candlestick", "bar", "line", "area"];
const CHART_TYPE_LABEL: Record<ChartType, string> = {
  candlestick: "Candles",
  bar: "Bars",
  line: "Line",
  area: "Area",
};

function isChartType(value: string | null): value is ChartType {
  return value === "candlestick" || value === "bar" || value === "line" || value === "area";
}

function loadChartType(): ChartType {
  if (typeof window === "undefined") return "candlestick";
  const raw = window.localStorage.getItem(CHART_TYPE_STORAGE_KEY);
  return isChartType(raw) ? raw : "candlestick";
}

function isOhlcType(type: ChartType): boolean {
  return type === "candlestick" || type === "bar";
}

function toBar(candle: Candle) {
  return { time: toTime(candle.time), open: candle.open, high: candle.high, low: candle.low, close: candle.close };
}

function toLinePoint(candle: Candle) {
  return { time: toTime(candle.time), value: candle.close };
}

/** Shapes one candle for whichever series type is currently active -- OHLC types
 * (Candlestick/Bar) keep the real open/high/low/close, value types (Line/Area) plot
 * the close only, same as TradingView's own Line/Area modes. */
function toSeriesPoint(candle: Candle, type: ChartType) {
  return isOhlcType(type) ? toBar(candle) : toLinePoint(candle);
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
  // Loosely typed on purpose: this ref holds whichever ONE of Candlestick/Bar/Line/Area
  // is currently active (see createMainSeries below). Every call site that touches it
  // already knows the real shape via `chartType`/toSeriesPoint, so a strict per-type
  // generic here would only fight itself across four different addSeries() results.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  const forecastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  // v5's markers are a primitive returned by createSeriesMarkers, not a method on the
  // series itself (series.setMarkers() was removed in v5) -- recreated alongside the
  // main series every time it's (re)created, updated in place via .setMarkers() from
  // redrawAnnotations.
  const seriesMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const forecastLabelRef = useRef<HTMLDivElement>(null);
  // Kept current via the effect below so the visible-range-change subscription (wired up
  // once, in the mount-only effect) always saves under today's pair/timeframe rather than
  // whatever was selected when the chart was first created.
  const pairRef = useRef(pair);
  const timeframeRef = useRef(timeframe);
  useEffect(() => {
    pairRef.current = pair;
    timeframeRef.current = timeframe;
  }, [pair, timeframe]);

  const [chartType, setChartType] = useState<ChartType>(loadChartType);
  // Read by the mount-only effect and the live-update effect, both of which can't take
  // `chartType` itself as a dependency without re-running on every switch (the mount
  // effect must only run once; the live-update effect already has its own real deps) --
  // same "ref mirrors state for effects that can't depend on it directly" pattern used
  // elsewhere in this app (e.g. Dashboard.tsx's selectedPairRef).
  const chartTypeRef = useRef(chartType);
  useEffect(() => {
    chartTypeRef.current = chartType;
  }, [chartType]);

  const renderAll = useCallback((candles: Candle[]) => {
    const type = chartTypeRef.current;
    seriesRef.current?.setData(candles.map((c) => toSeriesPoint(c, type)));
  }, []);

  // Clears this pair+timeframe's saved zoom (see handleVisibleRangeChange below) and
  // re-fits the chart to the full loaded history -- the only way back to "normal" once a
  // pair has gotten stuck zoomed in, since the saved range otherwise wins on every
  // future reload/pair-switch (see the reseed effect's savedRange check).
  const resetZoom = useCallback(() => {
    window.localStorage.removeItem(visibleRangeStorageKey(pair, timeframe));
    chartRef.current?.timeScale().fitContent();
  }, [pair, timeframe]);

  // Draws (or clears) the entry/SL/TP/zone price lines and the AI forecast curve for
  // the currently held `prediction` prop, against whatever candle history is currently
  // loaded. Never fabricates a curve for a no_trade evaluation -- there's no entry/TP
  // to derive one from. Price lines/markers work identically across all four series
  // types (a lightweight-charts series-level feature, not specific to Candlestick).
  const redrawAnnotations = useCallback(() => {
    const series = seriesRef.current;
    const forecastSeries = forecastSeriesRef.current;
    if (!series || !forecastSeries) return;

    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    forecastSeries.setData([]);
    seriesMarkersRef.current?.setMarkers([]);
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

    // A single directional marker at the signal's own candle -- distinct from the
    // dotted forecast curve (which projects a path, not a fixed marker) and the price
    // lines (which show levels, not the specific candle the setup fired on).
    seriesMarkersRef.current?.setMarkers([
      {
        time: toTime(lastCandle.time),
        position: signal.direction === "long" ? "belowBar" : "aboveBar",
        color: signal.direction === "long" ? UP_COLOR : DOWN_COLOR,
        shape: signal.direction === "long" ? "arrowUp" : "arrowDown",
      },
    ]);

    const barMs = TIMEFRAME_MS[timeframe];
    forecastSeries.applyOptions({ color: signal.direction === "long" ? UP_COLOR : DOWN_COLOR });
    forecastSeries.setData([
      { time: toTime(lastCandle.time), value: lastCandle.close },
      { time: toTime(lastCandle.time + barMs * FORECAST_BAR_SPACING), value: signal.takeProfit },
      { time: toTime(lastCandle.time + barMs * FORECAST_BAR_SPACING * 2), value: signal.takeProfit2 },
    ]);
    if (forecastLabelRef.current) forecastLabelRef.current.style.display = "block";
  }, [prediction, pair, timeframe]);

  // Creates (or re-creates, on a chart-type switch) the main price series, bound to
  // whichever ONE of the four TradingView-style chart types is currently selected --
  // lightweight-charts v5 has no way to change an existing series' type in place, only
  // remove and add a new one. Markers plugin is recreated alongside it every time (v5's
  // createSeriesMarkers binds to one specific series instance, not the chart itself).
  const createMainSeries = useCallback((chart: IChartApi, type: ChartType) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let series: ISeriesApi<any>;
    if (type === "candlestick") {
      series = chart.addSeries(CandlestickSeries, {
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        borderVisible: false,
        wickUpColor: UP_COLOR,
        wickDownColor: DOWN_COLOR,
      });
    } else if (type === "bar") {
      series = chart.addSeries(BarSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR });
    } else if (type === "area") {
      series = chart.addSeries(AreaSeries, {
        lineColor: LINE_COLOR,
        topColor: "rgba(56, 189, 248, 0.28)",
        bottomColor: "rgba(56, 189, 248, 0.02)",
        lineWidth: 2,
      });
    } else {
      series = chart.addSeries(LineSeries, { color: LINE_COLOR, lineWidth: 2 });
    }
    seriesRef.current = series;
    seriesMarkersRef.current = createSeriesMarkers(series, []);
  }, []);

  // Swaps the active series when the user picks a different chart type from the
  // buttons below -- removes the old one, creates the new one, and re-renders the
  // already-loaded candle history + annotations against it (no refetch needed).
  // Persisted globally (not per pair/timeframe), matching how a real trading
  // platform's chart-type choice works.
  const switchChartType = useCallback(
    (type: ChartType) => {
      const chart = chartRef.current;
      const oldSeries = seriesRef.current;
      if (!chart || !oldSeries || type === chartTypeRef.current) return;
      chart.removeSeries(oldSeries);
      createMainSeries(chart, type);
      // Set synchronously, not just via the `chartType` state -> effect mirror below --
      // renderAll (called a few lines down, in this same synchronous call) reads this
      // ref directly, and the effect wouldn't run until after this function returns.
      // Confirmed as a real bug live: switching to Line/Area threw "item data value
      // must be a number, got=undefined" because renderAll was still mapping data for
      // the OLD (OHLC) type into a series that now expects {time, value}.
      chartTypeRef.current = type;
      seriesRef.current?.applyOptions({
        priceFormat: { type: "price", precision: decimals(pair), minMove: 1 / 10 ** decimals(pair) },
      });
      renderAll(candlesRef.current);
      redrawAnnotations();
      window.localStorage.setItem(CHART_TYPE_STORAGE_KEY, type);
      setChartType(type);
    },
    [pair, createMainSeries, renderAll, redrawAnnotations]
  );

  // Chart + series lifecycle: created once per mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#a1a1aa" },
      grid: { vertLines: { color: "#27272a" }, horzLines: { color: "#27272a" } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });

    createMainSeries(chart, chartTypeRef.current);

    // Low-opacity dotted line, distinct from the main series, so it reads as
    // "illustrative" rather than real price action -- see the AI FORECAST label overlay.
    // Unaffected by chart-type switching -- always a dotted Line regardless of what the
    // main series currently is.
    const forecast = chart.addSeries(LineSeries, {
      lineWidth: 2,
      lineStyle: LineStyle.Dotted,
      color: UP_COLOR,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    forecastSeriesRef.current = forecast;

    // Persists the user's own zoom/pan so it survives a page refresh (and switching back
    // to a pair/timeframe they'd already zoomed earlier) instead of always resetting to
    // fitContent() -- see the reseed effect below, which reads this back. `range` is null
    // right after the chart is created (no data yet) -- ignored rather than clearing the
    // just-restored value, or that spurious event would race the reseed effect's own read
    // of localStorage and wipe out the saved zoom before it's ever used.
    const handleVisibleRangeChange = (range: IRange<Time> | null) => {
      if (!range) return;
      const key = visibleRangeStorageKey(pairRef.current, timeframeRef.current);
      window.localStorage.setItem(key, JSON.stringify(range));
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      forecastSeriesRef.current = null;
      seriesMarkersRef.current = null;
      priceLinesRef.current = [];
    };
    // createMainSeries is stable (its own useCallback has an empty dep array) --
    // intentionally excluded so this effect still only ever runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

        // Read the saved zoom BEFORE setData() below -- series.setData() auto-fits the
        // time scale itself the first time a series goes from empty to populated, which
        // fires the same visible-range-change subscription that persists the user's zoom
        // (see the mount effect above) and would otherwise clobber the very value being
        // restored here.
        const saved = window.localStorage.getItem(visibleRangeStorageKey(pair, timeframe));
        const savedRange = saved ? safeParseRange(saved) : null;

        candlesRef.current = data.candles;
        renderAll(data.candles);

        if (savedRange) chartRef.current?.timeScale().setVisibleRange(savedRange);
        else chartRef.current?.timeScale().fitContent();

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

    const prevLast = candlesRef.current[candlesRef.current.length - 1];
    // True for the overwhelming majority of events: a new bar forming, or a correction
    // to the bar still open on the chart. lightweight-charts' series.update() handles
    // both in O(1) -- no need to re-serialize and re-set every candle on the chart for
    // what's usually a single new/changed bar.
    const isAppendOrCurrentBar = !prevLast || streamEvent.candle.time >= prevLast.time;
    candlesRef.current = upsertCandle(candlesRef.current, streamEvent.candle);

    if (isAppendOrCurrentBar) {
      seriesRef.current?.update(toSeriesPoint(streamEvent.candle, chartTypeRef.current));
    } else {
      // Rare: a late "final" correction to a bar that's already closed on the chart (see
      // upsertCandle's own doc comment) -- series.update() only supports the most recent
      // bar, so this one case still needs a full redraw to land correctly.
      renderAll(candlesRef.current);
    }
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
      {/* z-10: lightweight-charts' own internal canvas layers are otherwise capturing
          clicks meant for these buttons -- confirmed with a real click, not just a
          visual overlap (no explicit z-index on either side means the library's canvas
          was winning the hit-test at this position despite coming earlier in the DOM). */}
      <div className="absolute left-2 top-2 z-10 flex items-center gap-1">
        {CHART_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => switchChartType(type)}
            className={`rounded px-2 py-1 text-[10px] font-medium transition ${
              chartType === type ? "bg-sky-600/80 text-white" : "bg-zinc-900/80 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {CHART_TYPE_LABEL[type]}
          </button>
        ))}
        <button
          type="button"
          onClick={resetZoom}
          className="rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-400 hover:text-zinc-200"
        >
          Reset zoom
        </button>
      </div>
      <div
        ref={forecastLabelRef}
        className="pointer-events-none absolute right-2 top-2 hidden rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-400"
      >
        AI FORECAST &middot; PROJECTED PATH (illustrative, not a price prediction)
      </div>
    </div>
  );
}
