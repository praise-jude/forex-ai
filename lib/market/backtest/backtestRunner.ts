import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { JournalEntry } from "../tradeJournal";
import { getPerformanceStats, type PerformanceStats } from "../tradeJournal";
import type { Candle, Pair, Timeframe } from "../types";
import { PAIRS } from "../types";
import { loadExecutionConfig } from "../executionConfig";
import { getBacktestAccount, loadHistoricalRange, loadSymbolSpecs } from "./historyLoader";
import { runBacktest, type BacktestBarResult, type RealisticSimConfig } from "./backtestEngine";
import { applyEarlyInvalidation } from "./backtestInvalidation";
import { BACKTEST_TIMEFRAMES, DEFAULT_REALISTIC_SPREAD_FRACTION, MAX_LOOKBACK_DAYS } from "./constants";
import {
  computeProfitFactor,
  computeScoreRangeBreakdown,
  computeSharpeRatio,
  computeStreaks,
  toJournalEntries,
  DEFAULT_HYPOTHETICAL_EQUITY,
  type RealisticSizingConfig,
  type ScoreRangeBucket,
  type StreakStats,
} from "./backtestStats";

export { BACKTEST_TIMEFRAMES, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS } from "./constants";

// Same fs.readFileSync/writeFileSync JSON-file pattern as tradeJournal.ts -- this app
// has no database for its trading data (see tradeJournal.ts's own comment).
const STORE_FILE = process.env.BACKTEST_STORE_FILE ?? ".backtest-results.json";
const MAX_HISTORY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// Lead-in history fetched BEFORE the requested window, per series -- must exceed
// emaTrendDirection's 200-bar EMA warmup on each higher timeframe (see
// lib/market/indicators/emaTrend.ts) and the primary timeframe's own detector lookback
// (liquidity-sweep/structure window, ADX/ATR/RSI/MACD warmups), or the first stretch of
// every backtest window would spuriously read as neutral/no-setup, understating real
// signal count. Lead-in bars are context-only -- never individually scored, see
// backtestEngine.ts's windowStart handling.
const LEAD_IN_DAYS = { d1: 220, h4: 40, h1: 10, primary: 3 };

// The 5 majors currencyStrength.ts's own TRACKED_CURRENCIES basket is built from --
// fetched once per run regardless of which pairs are under test, since currency
// strength needs all 5 (see computeHistoricalUsdStrength). Reuses loadHistoricalRange's
// same H1 series shape currencyStrength.ts's own live poll cadence assumes.
const CURRENCY_STRENGTH_PAIRS: Pair[] = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"];

export interface BacktestRequest {
  pairs: Pair[];
  timeframe: Timeframe;
  lookbackDays: number;
  /** Simulates break-even/trailing-stop position management, real lot-size-based
   * sizing, and spread cost instead of the idealized fixed SL-vs-TP1 outcome -- see
   * backtestEngine.ts's simulateRealisticOutcome. Defaults false so the existing quick/
   * idealized path is unaffected for anyone not opting in. */
  realistic?: boolean;
}

export type BacktestStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BacktestProgress {
  pairsDone: number;
  pairsTotal: number;
  /** Bars evaluated/total WITHIN the pair currently being processed -- each pair's own
   * total bar count isn't known until its history has been fetched, so this resets per
   * pair rather than tracking one global total across the whole run. */
  barsEvaluated: number;
  barsTotal: number;
}

export interface BacktestResult {
  stats: PerformanceStats;
  profitFactor: number | null;
  sharpeRatio: number | null;
  streaks: StreakStats;
  scoreRangeBreakdown: ScoreRangeBucket[];
  /** Signals that fired but never resolved (hit neither SL nor TP1) before the window
   * ran out -- excluded from every stat above, see backtestStats.ts's toJournalEntries. */
  openAtWindowEnd: number;
  perPair: { pair: Pair; stats: PerformanceStats }[];
  entries: JournalEntry[];
}

export interface BacktestJob {
  id: string;
  createdAt: number;
  request: BacktestRequest;
  status: BacktestStatus;
  progress: BacktestProgress;
  error: string | null;
  result: BacktestResult | null;
}

interface OnDisk {
  history: BacktestJob[];
}

// A plain property read (even through an intermediate annotated local) still gets
// narrowed by TS to whatever literal was last assigned to job.status earlier in this
// same function, which makes a later `=== "cancelled"` check against that literal a
// compile error even though the real runtime value can change any time via cancel().
// Reading it through an opaque function call is the reliable way to defeat that
// narrowing.
function readStatus(job: BacktestJob): BacktestStatus {
  return job.status;
}

function readFromDisk(): OnDisk {
  try {
    const raw = fs.readFileSync(/* turbopackIgnore: true */ STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OnDisk>;
    return { history: parsed.history ?? [] };
  } catch {
    return { history: [] };
  }
}

class BacktestRunner {
  private diskState: OnDisk | null = null;
  private current: BacktestJob | null = null;

  private loadDisk(): OnDisk {
    if (!this.diskState) this.diskState = readFromDisk();
    return this.diskState;
  }

  private persist(): void {
    fs.writeFileSync(STORE_FILE, JSON.stringify(this.loadDisk(), null, 2));
  }

  status(): BacktestJob | null {
    return this.current;
  }

  listHistory(): BacktestJob[] {
    return this.loadDisk().history;
  }

  getById(id: string): BacktestJob | null {
    if (this.current?.id === id) return this.current;
    return this.loadDisk().history.find((j) => j.id === id) ?? null;
  }

  /** Concurrency = 1, app-wide -- matches this app's existing one-connection-per-account
   * posture (no worker pool anywhere else). Returns an error, never throws, on an
   * invalid request or a job already in flight. */
  start(request: BacktestRequest): BacktestJob | { error: string } {
    if (this.current && (this.current.status === "queued" || this.current.status === "running")) {
      return { error: "a backtest is already running" };
    }
    if (request.pairs.length === 0 || !request.pairs.every((p) => PAIRS.includes(p))) {
      return { error: "pairs must be a non-empty subset of the configured pairs" };
    }
    if (!BACKTEST_TIMEFRAMES.includes(request.timeframe)) {
      return { error: `timeframe must be one of ${BACKTEST_TIMEFRAMES.join(", ")}` };
    }
    if (!Number.isFinite(request.lookbackDays) || request.lookbackDays < 1 || request.lookbackDays > MAX_LOOKBACK_DAYS) {
      return { error: `lookbackDays must be between 1 and ${MAX_LOOKBACK_DAYS}` };
    }

    const job: BacktestJob = {
      id: randomUUID(),
      createdAt: Date.now(),
      request,
      status: "queued",
      progress: { pairsDone: 0, pairsTotal: request.pairs.length, barsEvaluated: 0, barsTotal: 0 },
      error: null,
      result: null,
    };
    this.current = job;
    void this.run(job); // fire-and-forget -- the API route handler never awaits this
    return job;
  }

  /** Cooperative -- checked between pairs, not mid-fetch/mid-replay. A large single-pair
   * run can't be interrupted instantly, only at the next pair boundary. */
  cancel(id: string): boolean {
    if (this.current?.id === id && this.current.status === "running") {
      this.current.status = "cancelled";
      return true;
    }
    return false;
  }

  private async run(job: BacktestJob): Promise<void> {
    job.status = "running";
    try {
      const account = await getBacktestAccount();

      const windowEnd = Date.now();
      const windowStart = windowEnd - job.request.lookbackDays * DAY_MS;
      const allResults: BacktestBarResult[] = [];
      const perPairResults: { pair: Pair; results: BacktestBarResult[] }[] = [];

      // Fetched once for the whole run, independent of job.request.pairs -- currency
      // strength always needs all 5 majors regardless of which pairs are being tested.
      const currencyStrengthCloses: Partial<Record<Pair, Candle[]>> = {};
      for (const csPair of CURRENCY_STRENGTH_PAIRS) {
        if (readStatus(job) === "cancelled") break;
        currencyStrengthCloses[csPair] = await loadHistoricalRange(
          account,
          csPair,
          "1h",
          new Date(windowStart - LEAD_IN_DAYS.h1 * DAY_MS),
          new Date(windowEnd)
        );
      }

      // Fetched once for the whole run, not per pair -- a single short-lived RPC
      // connection (see historyLoader.ts's loadSymbolSpecs) covering every requested
      // pair, rather than opening/closing one per pair.
      let realisticSim: RealisticSimConfig | undefined;
      let realisticSizing: RealisticSizingConfig | undefined;
      if (job.request.realistic) {
        const liveConfig = loadExecutionConfig("live");
        realisticSim = {
          positionManagement: {
            breakEvenTriggerR: liveConfig.breakEvenTriggerR,
            trailingArmTriggerR: liveConfig.trailingArmTriggerR,
            trailingDistanceFractionOfStop: liveConfig.trailingDistanceFractionOfStop,
            // Always false regardless of the account's real setting -- partial-close
            // simulation is a separate, later addition, see backtestEngine.ts's own
            // scope notes on why (a blended two-leg outcome, real added complexity).
            partialCloseEnabled: false,
          },
          spreadFractionOfStop: DEFAULT_REALISTIC_SPREAD_FRACTION,
        };
        realisticSizing = {
          specs: await loadSymbolSpecs(account, job.request.pairs),
          equity: DEFAULT_HYPOTHETICAL_EQUITY,
          riskPct: liveConfig.riskPerTradePct,
        };
      }

      for (const pair of job.request.pairs) {
        if (readStatus(job) === "cancelled") break;

        // Serial per series, serial per pair -- no Promise.all, matching
        // seedHistory.ts's own single-account serial-loop precedent and staying gentle
        // on MetaApi's per-account rate limits.
        const primary = await loadHistoricalRange(
          account,
          pair,
          job.request.timeframe,
          new Date(windowStart - LEAD_IN_DAYS.primary * DAY_MS),
          new Date(windowEnd)
        );
        const h1 = await loadHistoricalRange(account, pair, "1h", new Date(windowStart - LEAD_IN_DAYS.h1 * DAY_MS), new Date(windowEnd));
        const h4 = await loadHistoricalRange(account, pair, "4h", new Date(windowStart - LEAD_IN_DAYS.h4 * DAY_MS), new Date(windowEnd));
        const d1 = await loadHistoricalRange(account, pair, "1d", new Date(windowStart - LEAD_IN_DAYS.d1 * DAY_MS), new Date(windowEnd));

        const rawResults = runBacktest({
          pair,
          timeframe: job.request.timeframe,
          primary,
          h1,
          h4,
          d1,
          windowStart,
          windowEnd,
          realistic: realisticSim,
          currencyStrengthCloses,
          onBar: (done, total) => {
            job.progress.barsEvaluated = done;
            job.progress.barsTotal = total;
          },
        });
        const results = applyEarlyInvalidation(rawResults);

        allResults.push(...results);
        perPairResults.push({ pair, results });
        job.progress.pairsDone++;
      }

      const converted = toJournalEntries(allResults, undefined, realisticSizing);
      const perPair = perPairResults.map(({ pair, results }) => ({
        pair,
        stats: getPerformanceStats(toJournalEntries(results, undefined, realisticSizing).entries),
      }));

      job.result = {
        stats: getPerformanceStats(converted.entries),
        profitFactor: computeProfitFactor(converted.entries),
        sharpeRatio: computeSharpeRatio(converted.entries),
        streaks: computeStreaks(converted.entries),
        scoreRangeBreakdown: computeScoreRangeBreakdown(converted.entries),
        openAtWindowEnd: converted.openAtWindowEnd,
        perPair,
        entries: converted.entries,
      };
      if (readStatus(job) !== "cancelled") job.status = "completed";
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      const state = this.loadDisk();
      state.history.unshift(job);
      state.history = state.history.slice(0, MAX_HISTORY);
      this.persist();
    }
  }
}

const globalKey = Symbol.for("forex-ai.backtestRunner");
type GlobalWithRunner = typeof globalThis & { [globalKey]?: BacktestRunner };
const g = globalThis as GlobalWithRunner;

export const backtestRunner: BacktestRunner = g[globalKey] ?? (g[globalKey] = new BacktestRunner());
