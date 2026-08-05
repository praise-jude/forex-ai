import { Dashboard } from "@/components/dashboard/Dashboard";

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-white/10 px-5 py-4">
        <h1 className="text-lg font-semibold">Forex AI &mdash; SMC Signals</h1>
        <p className="text-sm text-zinc-500">Signal-only &middot; not financial advice &middot; no trades are placed automatically</p>
      </header>
      <Dashboard />
    </main>
  );
}
