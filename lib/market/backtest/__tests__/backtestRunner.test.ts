import { describe, expect, it } from "vitest";
import { recoverInterruptedJob, type OnDisk } from "../backtestRunner";
import type { BacktestJob } from "../backtestRunner";

function buildJob(overrides: Partial<BacktestJob> = {}): BacktestJob {
  return {
    id: "job-1",
    createdAt: 1000,
    request: { pairs: ["EUR/USD", "GBP/USD"], timeframe: "15m", lookbackDays: 60, realistic: true },
    status: "running",
    progress: { pairsDone: 1, pairsTotal: 2, barsEvaluated: 500, barsTotal: 1000 },
    error: null,
    result: null,
    ...overrides,
  };
}

describe("recoverInterruptedJob", () => {
  it("returns the input unchanged when there's no current job at all", () => {
    const disk: OnDisk = { history: [], current: null };
    expect(recoverInterruptedJob(disk)).toBe(disk);
  });

  it("returns the input unchanged when the current job already finished (completed/failed/cancelled)", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const disk: OnDisk = { history: [], current: buildJob({ status }) };
      expect(recoverInterruptedJob(disk)).toBe(disk);
    }
  });

  it("turns a 'running' job into an honest 'failed' history entry, preserving its progress", () => {
    const interrupted = buildJob({ status: "running", progress: { pairsDone: 5, pairsTotal: 10, barsEvaluated: 200, barsTotal: 400 } });
    const disk: OnDisk = { history: [], current: interrupted };

    const result = recoverInterruptedJob(disk);

    expect(result.current).toBeNull();
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      id: "job-1",
      status: "failed",
      progress: { pairsDone: 5, pairsTotal: 10 },
    });
    expect(result.history[0].error).toContain("Interrupted");
  });

  it("also recovers a 'queued' job (never even got to start running)", () => {
    const disk: OnDisk = { history: [], current: buildJob({ status: "queued" }) };
    const result = recoverInterruptedJob(disk);
    expect(result.current).toBeNull();
    expect(result.history[0].status).toBe("failed");
  });

  it("prepends the recovered job ahead of existing history, without discarding it", () => {
    const oldEntry = buildJob({ id: "old-job", status: "completed" });
    const disk: OnDisk = { history: [oldEntry], current: buildJob({ id: "new-job", status: "running" }) };

    const result = recoverInterruptedJob(disk);

    expect(result.history).toHaveLength(2);
    expect(result.history[0].id).toBe("new-job");
    expect(result.history[1].id).toBe("old-job");
  });

  it("caps recovered history at MAX_HISTORY (20), same as a normal job completion", () => {
    const existing = Array.from({ length: 20 }, (_, i) => buildJob({ id: `old-${i}`, status: "completed" }));
    const disk: OnDisk = { history: existing, current: buildJob({ id: "new-job", status: "running" }) };

    const result = recoverInterruptedJob(disk);

    expect(result.history).toHaveLength(20);
    expect(result.history[0].id).toBe("new-job");
    expect(result.history[19].id).toBe("old-18"); // the oldest entry (old-19) got pushed out
  });
});
