import Link from "next/link";
import { BacktestPanel } from "@/components/dashboard/BacktestPanel";

export default function BacktestPage() {
  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h1 className="text-lg font-semibold">Backtest</h1>
          <p className="text-sm text-zinc-500">
            Replays the real signal engine (same gates, same scoring) against historical candles -- one run at a time, read the
            limitations banner in the results before trusting the numbers.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="self-start rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 sm:self-auto"
        >
          ← Dashboard
        </Link>
      </header>
      <div className="p-4 sm:p-5">
        <BacktestPanel />
      </div>
    </main>
  );
}
