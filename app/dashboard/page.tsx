import Link from "next/link";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { KillSwitchControl } from "@/components/dashboard/KillSwitchControl";
import { ConnectionStatus } from "@/components/dashboard/ConnectionStatus";
import { EngineModeControl } from "@/components/dashboard/EngineModeControl";

export default function DashboardPage() {
  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold">Forex AI &mdash; SMC Signals</h1>
            <p className="text-sm text-zinc-500">
              ANALYSIS mode: signal-only, no trades placed automatically &middot; DEMO/LIVE modes auto-execute confirmed
              signals &middot; manual Buy/Sell always targets the account matching the current mode
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <Link href="/chat" className="rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700">
              JUDE Chat
            </Link>
            <Link href="/journal" className="rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700">
              Journal
            </Link>
            <ConnectionStatus />
            <KillSwitchControl />
          </div>
        </div>
        <EngineModeControl />
      </header>
      <Dashboard />
    </main>
  );
}
