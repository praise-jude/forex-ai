import Link from "next/link";
import { JournalPanel } from "@/components/dashboard/JournalPanel";

export default function JournalPage() {
  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h1 className="text-lg font-semibold">Trade journal</h1>
          <p className="text-sm text-zinc-500">
            Every closed trade this app opened, with the real decision context it fired on and its actual outcome.
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
        <JournalPanel />
      </div>
    </main>
  );
}
