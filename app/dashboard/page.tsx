import { Dashboard } from "@/components/dashboard/Dashboard";
import { KillSwitchControl } from "@/components/dashboard/KillSwitchControl";
import { ConnectionStatus } from "@/components/dashboard/ConnectionStatus";

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold">Forex AI &mdash; SMC Signals</h1>
          <p className="text-sm text-zinc-500">Signal-only &middot; not financial advice &middot; no trades are placed automatically</p>
        </div>
        <div className="flex items-center gap-4">
          <ConnectionStatus />
          <KillSwitchControl />
        </div>
      </header>
      <Dashboard />
    </main>
  );
}
