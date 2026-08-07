import { Dashboard } from "@/components/dashboard/Dashboard";
import { KillSwitchControl } from "@/components/dashboard/KillSwitchControl";
import { ConnectionStatus } from "@/components/dashboard/ConnectionStatus";
import { EngineModeControl } from "@/components/dashboard/EngineModeControl";

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/10 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Forex AI &mdash; SMC Signals</h1>
            <p className="text-sm text-zinc-500">
              ANALYSIS mode: signal-only, no trades placed automatically &middot; DEMO/LIVE modes auto-execute confirmed
              signals &middot; manual Buy/Sell always targets the account matching the current mode
            </p>
          </div>
          <div className="flex items-center gap-4">
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
