"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, OpenPosition, Pair, PredictionUpdate, StreamEvent, Timeframe } from "@/lib/market/types";
import { decimals } from "@/lib/market/symbols";
import { TIMEFRAME_MS } from "@/lib/market/timeframes";
import { usePolledResource } from "@/lib/hooks/usePolledResource";
import { describeMeasurement, measureCandleRange } from "@/lib/market/chartMeasurement";
import type { DurationStats } from "@/lib/market/tradeJournal";
import { formatDurationApprox } from "@/lib/market/format";

interface MeasureSelection {
  pair: Pair;
  timeframe: Timeframe;
  points: Candle[];
}

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
// Distinct from UP_COLOR/DOWN_COLOR/LINE_COLOR on purpose -- a range measurement is
// neither "the AI's forecast" nor "a live position," it's the operator's own retrospective
// question about candles that already closed, so it gets its own visual identity rather
// than borrowing a color that would imply one of those other two meanings.
const MEASURE_COLOR = "#a78bfa";
// A single stable reference for "no measurement selected" -- see measurePoints' own
// derivation below for why a fresh [] literal there would defeat redrawMeasurement's
// memoization and re-run on every unrelated poll-driven re-render (this component
// already re-renders roughly every second from the positions poll).
const EMPTY_CANDLES: Candle[] = [];

// Same shared "positions" key/interval PositionsPanel.tsx already polls -- usePolledResource
// dedupes them onto one request either way, but matching the interval here too means
// whichever of the two components happens to mount first doesn't leave the other on a
// slower-than-intended cadence.
const POSITIONS_POLL_MS = 1000;

interface PositionsResponse {
  positions: OpenPosition[];
}

async function fetchPositions(): Promise<PositionsResponse> {
  const res = await fetch("/api/positions");
  return res.json();
}

// Real closed-trade duration data changes only when a trade actually closes -- a rare
// event relative to POSITIONS_POLL_MS's 1s cadence, so this gets its own far slower
// interval rather than piggybacking on that one.
const DURATION_STATS_POLL_MS = 5 * 60_000;

async function fetchDurationStats(pair: Pair, timeframe: Timeframe): Promise<DurationStats> {
  const res = await fetch(`/api/trade-journal/duration?pair=${encodeURIComponent(pair)}&timeframe=${encodeURIComponent(timeframe)}`);
  return res.json();
}

/** Formats the "how long has this typically taken" readout from real closed-trade
 * history -- deliberately never a time-to-target claim for THIS specific open signal
 * (see FORECAST_BAR_SPACING's own doc comment on why the forecast curve itself makes
 * no timing claim at all). Returns a real reading when at least one side of
 * computeDurationStats' minSamples bar is cleared, an honest "not enough data yet"
 * otherwise -- never silently omitted, so the feature reads as "still collecting
 * data" rather than simply absent. */
function describeDurationStats(stats: DurationStats | null): string {
  const parts: string[] = [];
  if (stats?.takeProfit.status === "calibrated" && stats.takeProfit.medianMs !== null) {
    parts.push(`TP in ~${formatDurationApprox(stats.takeProfit.medianMs)} (${stats.takeProfit.sampleSize} trades)`);
  }
  if (stats?.stopLoss.status === "calibrated" && stats.stopLoss.medianMs !== null) {
    parts.push(`SL in ~${formatDurationApprox(stats.stopLoss.medianMs)} (${stats.stopLoss.sampleSize} trades)`);
  }
  if (parts.length > 0) return `Similar past trades: ${parts.join(" · ")}`;
  return "Similar-trade timing: not enough closed trades on this pair yet";
}

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
  // Solid entry->target path for a REAL, already-placed trade -- distinct from
  // forecastSeriesRef's dotted "illustrative, not yet real" curve above. Whichever
  // signer/source placed the trade (SMC, Signer B, the combined decision matrix, or a
  // JUDE chat proposal) is irrelevant here: by the time a position exists, it's just
  // real broker data, not a signal-specific concept.
  const positionPathSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const positionLabelRef = useRef<HTMLDivElement>(null);
  // The operator's own retrospective "what happened from here to here" range check --
  // see MEASURE_COLOR's own doc comment for why this gets a distinct color/series from
  // both the forecast curve and the live position path.
  const measureSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const measureLabelRef = useRef<HTMLDivElement>(null);
  // v5's markers are a primitive returned by createSeriesMarkers, not a method on the
  // series itself (series.setMarkers() was removed in v5) -- recreated alongside the
  // main series every time it's (re)created, updated in place via .setMarkers() from
  // redrawAnnotations.
  const seriesMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  // True while redrawAnnotations is touching the forecast/position-path series -- see
  // its own doc comment on why those setData() calls can trigger a spurious auto-fit.
  // handleVisibleRangeChange checks this to skip persisting that transient range to
  // localStorage; without it, the corruption survived a page reload even though
  // redrawAnnotations' own explicit restore fixed the CURRENT session's visual state --
  // confirmed as a real bug live (long position rendered correctly, but reloading for
  // the short-position screenshot came back to the narrow, candle-less view).
  const suppressRangePersistRef = useRef(false);
  const forecastLabelRef = useRef<HTMLDivElement>(null);
  // Shares the same visibility moments as forecastLabelRef/positionLabelRef (see
  // redrawAnnotations) but never mutually exclusive with them the way those two are with
  // each other -- this reads real closed-trade history, which is exactly as relevant to
  // an already-open position (how much longer might this take) as to a not-yet-real
  // forecast signal.
  const durationLabelRef = useRef<HTMLDivElement>(null);
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

  // Off by default -- ordinary chart interaction (crosshair, zoom, pan) is unaffected
  // either way, this only gates whether the click handler (wired up once, in the
  // mount-only effect below) treats a click as a measurement point. Same "ref mirrors
  // state for an effect that can't depend on it directly" pattern as chartTypeRef above.
  const [measureMode, setMeasureMode] = useState(false);
  const measureModeRef = useRef(measureMode);
  useEffect(() => {
    measureModeRef.current = measureMode;
  }, [measureMode]);
  // Tagged with the pair/timeframe it was picked under -- a selection made on one chart
  // is meaningless on another, and rather than clearing it via a setState-in-an-effect
  // (an anti-pattern React itself now lints against, see
  // https://react.dev/learn/you-might-not-need-an-effect), a stale selection just stops
  // matching the current pair/timeframe and is treated as empty everywhere it's read
  // below -- the render itself is the source of truth, not a synchronization step.
  // 0, 1, or 2 points; a third click starts a fresh selection from that click rather
  // than accumulating, see handleChartClick below.
  const [measureSelection, setMeasureSelection] = useState<MeasureSelection | null>(null);
  const measurePoints = useMemo(
    () => (measureSelection && measureSelection.pair === pair && measureSelection.timeframe === timeframe ? measureSelection.points : EMPTY_CANDLES),
    [measureSelection, pair, timeframe]
  );

  // Only ever the FIRST open position for this pair -- a real account could theoretically
  // hold more than one on the same pair, and drawing a path per position would just be
  // visual noise; the most useful single path is whichever one this app itself placed
  // and can date (see openedAt's own doc comment on OpenPosition).
  const { data: positionsData } = usePolledResource<PositionsResponse>("positions", fetchPositions, POSITIONS_POLL_MS);
  const openPosition = positionsData?.positions.find((p) => p.pair === pair && p.openedAt !== undefined && p.takeProfit !== undefined);
  // A stable, value-based key for redrawAnnotations' dependency array below -- the
  // 1s poll above hands back a brand-new object every tick even when nothing about the
  // position actually changed, which made redrawAnnotations (and therefore
  // positionPathSeries.setData()) re-run every second. Confirmed as a real bug live:
  // lightweight-charts treats each of those as a fresh empty->populated transition and
  // re-auto-fits the time scale to it, silently fighting the user's own zoom/pan every
  // second while a position is open. Keying off real field values instead means the
  // callback only actually changes identity when something real changes (open, close,
  // or a partial-close moving SL/TP) -- see the closure-staleness note where it's used.
  const openPositionKey = openPosition
    ? `${openPosition.id}:${openPosition.direction}:${openPosition.openPrice}:${openPosition.takeProfit}:${openPosition.stopLoss}:${openPosition.openedAt}`
    : null;

  const { data: durationStats } = usePolledResource<DurationStats>(
    `duration:${pair}:${timeframe}`,
    () => fetchDurationStats(pair, timeframe),
    DURATION_STATS_POLL_MS
  );

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

  // Draws (or clears) the entry/SL/TP/zone price lines and either the real open-position
  // path or the AI forecast curve, against whatever candle history is currently loaded.
  // An open position for this pair always wins over the prediction-based forecast --
  // once a trade is actually placed, its real entry/SL/TP are the meaningful thing to
  // show, not an illustrative projection for a setup that may have already moved on.
  // Price lines/markers work identically across all four series types (a
  // lightweight-charts series-level feature, not specific to Candlestick).
  const redrawAnnotations = useCallback(() => {
    const series = seriesRef.current;
    const forecastSeries = forecastSeriesRef.current;
    const positionPathSeries = positionPathSeriesRef.current;
    if (!series || !forecastSeries || !positionPathSeries) return;

    // Captured BEFORE touching forecast/position-path below, then explicitly restored
    // after -- confirmed as a real bug live: per this file's own established note on
    // series.setData() ("auto-fits the time scale itself the first time a series goes
    // from empty to populated"), that behavior is per-SERIES, not a fit to the union of
    // every series on the chart. The position path's own first setData() call
    // independently snapped the whole chart to just its own narrow entry->target range,
    // squeezing every real candle out of view. Reading the chart's OWN current range
    // (not localStorage) sidesteps a second bug that reading-after-the-fact hit: the
    // clobbering setData call itself fires the same visible-range-change subscription
    // that persists zoom to localStorage, so a post-hoc localStorage read could pick up
    // the very corruption this is meant to undo.
    const rangeBeforeAnnotations = chartRef.current?.timeScale().getVisibleRange() ?? null;
    suppressRangePersistRef.current = true;

    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    forecastSeries.setData([]);
    positionPathSeries.setData([]);
    seriesMarkersRef.current?.setMarkers([]);
    if (forecastLabelRef.current) forecastLabelRef.current.style.display = "none";
    if (positionLabelRef.current) positionLabelRef.current.style.display = "none";
    if (durationLabelRef.current) durationLabelRef.current.style.display = "none";

    const addLine = (price: number, color: string, title: string) => {
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title })
      );
    };

    if (openPosition && openPosition.openedAt !== undefined && openPosition.takeProfit !== undefined) {
      addLine(openPosition.openPrice, "#a1a1aa", "Entry");
      if (openPosition.stopLoss !== undefined) addLine(openPosition.stopLoss, DOWN_COLOR, "SL");
      addLine(openPosition.takeProfit, UP_COLOR, "TP");

      const lastCandle = candlesRef.current[candlesRef.current.length - 1];
      const barMs = TIMEFRAME_MS[timeframe];
      // Point A is the real fill time, clamped to never sit AFTER the newest loaded
      // candle -- confirmed as a real bug live: a genuinely open position's real
      // openedAt can be well ahead of the last loaded candle (a stale connection, or a
      // forex position still open across the weekend candle gap), and plotting point A
      // out there forced the chart to auto-scale around it, squeezing every real candle
      // into an invisible sliver. Point B has no real "when it'll hit TP" to plot
      // (that's the future), so it's projected the same illustrative distance past the
      // latest candle the AI forecast curve uses below -- same visual language, just
      // solid (real trade) instead of dotted (not yet real).
      const pointATime = lastCandle ? Math.min(openPosition.openedAt, lastCandle.time) : openPosition.openedAt;
      const pointBTime = lastCandle ? lastCandle.time + barMs * FORECAST_BAR_SPACING : openPosition.openedAt + barMs * FORECAST_BAR_SPACING;
      positionPathSeries.applyOptions({ color: openPosition.direction === "long" ? UP_COLOR : DOWN_COLOR });
      positionPathSeries.setData([
        { time: toTime(pointATime), value: openPosition.openPrice },
        { time: toTime(Math.max(pointBTime, pointATime + barMs)), value: openPosition.takeProfit },
      ]);
      if (positionLabelRef.current) positionLabelRef.current.style.display = "block";
      if (durationLabelRef.current) {
        durationLabelRef.current.textContent = describeDurationStats(durationStats);
        durationLabelRef.current.style.display = "block";
      }
      if (rangeBeforeAnnotations) chartRef.current?.timeScale().setVisibleRange(rangeBeforeAnnotations);
      suppressRangePersistRef.current = false;
      return;
    }

    if (!prediction || prediction.pair !== pair || prediction.timeframe !== timeframe) {
      suppressRangePersistRef.current = false;
      return;
    }
    if (prediction.evaluation.status !== "signal") {
      suppressRangePersistRef.current = false;
      return;
    }
    const signal = prediction.evaluation.signal;

    addLine(signal.entry, "#a1a1aa", "Entry");
    addLine(signal.stopLoss, DOWN_COLOR, "SL");
    addLine(signal.takeProfit, UP_COLOR, "TP1");
    addLine(signal.takeProfit2, UP_COLOR, "TP2");
    if (signal.zoneTop !== undefined) addLine(signal.zoneTop, "#60a5fa", "Zone");
    if (signal.zoneBottom !== undefined) addLine(signal.zoneBottom, "#60a5fa", "Zone");

    const lastCandle = candlesRef.current[candlesRef.current.length - 1];
    if (!lastCandle) {
      suppressRangePersistRef.current = false;
      return; // candles not loaded yet -- the history-reseed effect calls this again once they are
    }

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
    if (durationLabelRef.current) {
      durationLabelRef.current.textContent = describeDurationStats(durationStats);
      durationLabelRef.current.style.display = "block";
    }
    if (rangeBeforeAnnotations) chartRef.current?.timeScale().setVisibleRange(rangeBeforeAnnotations);
    suppressRangePersistRef.current = false;
    // openPosition itself (not just openPositionKey) is read in the body above -- safe
    // despite the narrower dep list: whenever openPositionKey is unchanged, the stale
    // closure's openPosition is guaranteed to hold identical field values (that's what
    // the key is built from), so re-running with it produces an identical result. This
    // is the whole point -- see openPositionKey's own doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction, pair, timeframe, openPositionKey, durationStats]);

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

  // Reacts to a click only while Measure mode is on (see measureModeRef's own doc
  // comment for why that's read via a ref rather than a dependency here) -- subscribed
  // once, in the mount-only effect below, rather than re-subscribing on every toggle.
  // A third click starts a fresh selection rather than accumulating a third point.
  const handleChartClick = useCallback((param: MouseEventParams<Time>) => {
    if (!measureModeRef.current || param.time === undefined) return;
    const clicked = candlesRef.current.find((c) => toTime(c.time) === param.time);
    if (!clicked) return;
    const currentPair = pairRef.current;
    const currentTimeframe = timeframeRef.current;
    setMeasureSelection((prev) => {
      if (!prev || prev.pair !== currentPair || prev.timeframe !== currentTimeframe || prev.points.length >= 2) {
        return { pair: currentPair, timeframe: currentTimeframe, points: [clicked] };
      }
      return { ...prev, points: [...prev.points, clicked] };
    });
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

    // Solid line, distinct from the forecast's dotted style -- see positionPathSeriesRef's
    // own doc comment. Also unaffected by chart-type switching.
    const positionPath = chart.addSeries(LineSeries, {
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      color: UP_COLOR,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });

    // Solid line, own color -- see MEASURE_COLOR's own doc comment. Also unaffected by
    // chart-type switching.
    const measure = chart.addSeries(LineSeries, {
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      color: MEASURE_COLOR,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    forecastSeriesRef.current = forecast;
    positionPathSeriesRef.current = positionPath;
    measureSeriesRef.current = measure;
    chart.subscribeClick(handleChartClick);

    // Persists the user's own zoom/pan so it survives a page refresh (and switching back
    // to a pair/timeframe they'd already zoomed earlier) instead of always resetting to
    // fitContent() -- see the reseed effect below, which reads this back. `range` is null
    // right after the chart is created (no data yet) -- ignored rather than clearing the
    // just-restored value, or that spurious event would race the reseed effect's own read
    // of localStorage and wipe out the saved zoom before it's ever used.
    const handleVisibleRangeChange = (range: IRange<Time> | null) => {
      if (!range || suppressRangePersistRef.current) return;
      const key = visibleRangeStorageKey(pairRef.current, timeframeRef.current);
      window.localStorage.setItem(key, JSON.stringify(range));
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
      chart.unsubscribeClick(handleChartClick);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      forecastSeriesRef.current = null;
      positionPathSeriesRef.current = null;
      measureSeriesRef.current = null;
      seriesMarkersRef.current = null;
      priceLinesRef.current = [];
    };
    // createMainSeries and handleChartClick are both stable (their own useCallbacks have
    // empty dep arrays) -- intentionally excluded so this effect still only ever runs
    // once per mount.
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

  // Redraw annotations whenever the prediction, the open-position data, or the selected
  // pair/timeframe changes -- redrawAnnotations itself decides which of the two
  // (real position path vs. illustrative forecast) actually applies.
  useEffect(() => {
    redrawAnnotations();
  }, [redrawAnnotations]);

  // Draws (or clears) the retrospective measurement line + readout between the two
  // operator-picked candles -- purely a report of what already happened (see
  // chartMeasurement.ts's own doc comment), never a prediction.
  const redrawMeasurement = useCallback(() => {
    const series = measureSeriesRef.current;
    if (!series) return;

    if (measurePoints.length < 2) {
      series.setData([]);
      if (measureLabelRef.current) measureLabelRef.current.style.display = "none";
      return;
    }

    // Same auto-fit-on-first-populate behavior redrawAnnotations already works around
    // (see its own doc comment) -- series.setData() going from empty to populated would
    // otherwise snap the chart's visible range to just these two points.
    const rangeBefore = chartRef.current?.timeScale().getVisibleRange() ?? null;
    suppressRangePersistRef.current = true;

    const [a, b] = measurePoints;
    const result = measureCandleRange(a, b, pair, timeframe);
    const color = result.direction === "up" ? UP_COLOR : result.direction === "down" ? DOWN_COLOR : MEASURE_COLOR;
    series.applyOptions({ color });
    series.setData([
      { time: toTime(result.fromTime), value: result.fromClose },
      { time: toTime(result.toTime), value: result.toClose },
    ]);
    if (measureLabelRef.current) {
      measureLabelRef.current.textContent = describeMeasurement(result);
      measureLabelRef.current.style.display = "block";
      measureLabelRef.current.style.color = color;
    }

    if (rangeBefore) chartRef.current?.timeScale().setVisibleRange(rangeBefore);
    suppressRangePersistRef.current = false;
  }, [measurePoints, pair, timeframe]);

  useEffect(() => {
    redrawMeasurement();
  }, [redrawMeasurement]);

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
        <button
          type="button"
          onClick={() => {
            setMeasureMode((on) => !on);
            setMeasureSelection(null);
          }}
          title="Click two candles to see what actually happened between them"
          className={`rounded px-2 py-1 text-[10px] font-medium transition ${
            measureMode ? "bg-violet-600/80 text-white" : "bg-zinc-900/80 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          📏 Range
        </button>
        {measurePoints.length > 0 && (
          <button
            type="button"
            onClick={() => setMeasureSelection(null)}
            className="rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-400 hover:text-zinc-200"
          >
            Clear range
          </button>
        )}
      </div>
      {measureMode && measurePoints.length < 2 && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-violet-300">
          Click {measurePoints.length === 0 ? "a candle to start" : "a second candle to finish"}
        </div>
      )}
      <div
        ref={measureLabelRef}
        className="pointer-events-none absolute bottom-2 left-2 z-10 hidden rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-violet-300"
      />
      <div
        ref={forecastLabelRef}
        className="pointer-events-none absolute right-2 top-2 hidden rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-400"
      >
        AI FORECAST &middot; PROJECTED PATH (illustrative, not a price prediction)
      </div>
      {/* Mutually exclusive with the forecast label above -- redrawAnnotations only ever
          shows one of the two for a given pair, so they can safely share the same slot. */}
      <div
        ref={positionLabelRef}
        className="pointer-events-none absolute right-2 top-2 hidden rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-emerald-400"
      >
        LIVE POSITION &middot; ENTRY &rarr; TARGET
      </div>
      {/* Stacks below whichever of the two labels above is showing -- real closed-trade
          duration history, not a claim about this specific signal/position's own timing.
          Content is set imperatively in redrawAnnotations (describeDurationStats), same
          pattern as the two labels above. */}
      <div
        ref={durationLabelRef}
        className="pointer-events-none absolute right-2 top-9 hidden rounded bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-400"
      />
    </div>
  );
}
