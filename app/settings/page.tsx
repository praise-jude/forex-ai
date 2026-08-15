import Link from "next/link";
import { EngineModeControl } from "@/components/dashboard/EngineModeControl";
import { ExecutionPolicyControl } from "@/components/dashboard/ExecutionPolicyControl";
import { KillSwitchControl } from "@/components/dashboard/KillSwitchControl";
import { EmergencyStopControl } from "@/components/dashboard/EmergencyStopControl";
import { SignalDiagnosticsPanel } from "@/components/dashboard/SignalDiagnosticsPanel";
import { loadExecutionConfig, type ExecutionConfig } from "@/lib/market/executionConfig";
import { isAccountConfigured } from "@/lib/market/metaApiConnection";

export const dynamic = "force-dynamic";

function ConfigRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 py-1.5 text-sm last:border-0">
      <span className="text-zinc-400">
        {label}
        {hint && <span className="ml-1.5 text-[11px] text-zinc-600">({hint})</span>}
      </span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

/** Read-only -- these come from env vars (see README's "Manual execution" config
 * table), not a live-editable API like engine mode/execution policy above. Making them
 * live-editable is a separate, larger change; this section exists so an operator can
 * actually see the account's real configured risk/sizing behavior in one place instead
 * of having to read .env.local or Railway's variable list. */
function ExecutionConfigTable({ account, config }: { account: string; config: ExecutionConfig }) {
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{account}</h3>
      <ConfigRow label="Risk per trade" value={`${config.riskPerTradePct}%`} />
      <ConfigRow label="Max concurrent positions" value={String(config.maxConcurrentPositions)} />
      <ConfigRow label="Max correlated positions" value={String(config.maxCorrelatedPositions)} />
      <ConfigRow label="Max daily loss" value={`${config.maxDailyLossPct}%`} />
      <ConfigRow label="Max trades per day" value={String(config.maxTradesPerDay)} />
      <ConfigRow label="Max consecutive losses" value={String(config.maxConsecutiveLosses)} hint={`${config.cooldownMinutes}min cooldown`} />
      <ConfigRow label="Max spread" value={`${(config.maxSpreadFractionOfStop * 100).toFixed(0)}% of stop distance`} />
      <ConfigRow label="M5 entry confirmation" value={config.m5ConfirmationEnabled ? "Enabled" : "Disabled"} />
      <ConfigRow
        label="Position management"
        value={config.positionManagementEnabled ? "Enabled" : "Disabled"}
        hint={`break-even @ ${config.breakEvenTriggerR}R, trailing @ ${config.trailingArmTriggerR}R`}
      />
      <ConfigRow
        label="Partial take-profit"
        value={config.partialCloseEnabled ? `Enabled (${(config.partialCloseFraction * 100).toFixed(0)}% at TP1)` : "Disabled"}
      />
      <ConfigRow
        label="Confidence-weighted sizing"
        value={
          config.confidenceSizingEnabled
            ? `Enabled (buy ${config.riskMultiplierBuy}x, strong_buy ${config.riskMultiplierStrongBuy}x)`
            : "Disabled"
        }
      />
    </div>
  );
}

export default function SettingsPage() {
  const liveConfig = loadExecutionConfig("live");
  const demoConfigured = isAccountConfigured("demo");
  const demoConfig = demoConfigured ? loadExecutionConfig("demo") : null;

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-zinc-500">Every execution/risk control and a live read of why AutoPilot is or isn&apos;t trading each pair.</p>
        </div>
        <Link
          href="/dashboard"
          className="self-start rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 sm:self-auto"
        >
          ← Dashboard
        </Link>
      </header>

      <div className="flex flex-col gap-5 p-4 sm:p-5">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Live controls</h2>
          <div className="flex flex-wrap items-center gap-2">
            <EngineModeControl />
            <ExecutionPolicyControl />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <KillSwitchControl account="live" />
            {demoConfigured && <KillSwitchControl account="demo" />}
            <EmergencyStopControl account="live" />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Risk &amp; execution config <span className="normal-case text-zinc-600">(env vars — see README)</span>
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <ExecutionConfigTable account="Live" config={liveConfig} />
            {demoConfig && <ExecutionConfigTable account="Demo" config={demoConfig} />}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Why is AutoPilot trading (or not) right now?</h2>
          <SignalDiagnosticsPanel />
        </section>
      </div>
    </main>
  );
}
