import Link from "next/link";
import { EngineModeControl } from "@/components/dashboard/EngineModeControl";
import { ExecutionPolicyControl } from "@/components/dashboard/ExecutionPolicyControl";
import { KillSwitchControl } from "@/components/dashboard/KillSwitchControl";
import { EmergencyStopControl } from "@/components/dashboard/EmergencyStopControl";
import { SignalDiagnosticsPanel } from "@/components/dashboard/SignalDiagnosticsPanel";
import { loadExecutionConfig, type ExecutionConfig } from "@/lib/market/executionConfig";
import { isAccountConfigured } from "@/lib/market/metaApiConnection";
import { tradeJournal, getConfidenceCalibration, type ConfidenceCalibrationBucket } from "@/lib/market/tradeJournal";

export const dynamic = "force-dynamic";

// Same "invalid/unset -> safe fallback" posture as executionConfig.ts's own envNumber --
// a non-positive or non-numeric override can't mean anything sensible here.
function minCalibrationSamples(): number {
  const raw = Number(process.env.CONFIDENCE_CALIBRATION_MIN_SAMPLES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

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

/** Read-only measurement, per the plan's own top safety principle: confidence must be
 * calibrated against real outcomes before it's ever allowed to influence position size
 * -- this section never has, and doesn't yet, feed anything back into sizing/execution. */
function CalibrationRow({ bucket, minSamples }: { bucket: ConfidenceCalibrationBucket; minSamples: number }) {
  const tierLabel = bucket.tier === "strong_buy" ? "Strong buy (95-100)" : "Buy (90-94)";
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-zinc-200">{tierLabel}</span>
        <span className="text-[11px] text-zinc-500">{bucket.sampleSize} closed trades</span>
      </div>
      {bucket.status === "insufficient_data" ? (
        <p className="mt-1 text-xs text-amber-400">
          Insufficient data — needs {minSamples}, have {bucket.sampleSize}. Using base risk only; no calibrated adjustment is possible yet.
        </p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-400">
          <span>
            Real win rate: <span className="font-mono text-zinc-200">{bucket.winRate?.toFixed(1)}%</span>
          </span>
          <span>
            Average R: <span className="font-mono text-zinc-200">{bucket.averageR?.toFixed(2)}R</span>
          </span>
          <span>
            Expectancy: <span className="font-mono text-zinc-200">{bucket.expectancy?.toFixed(2)}R</span>
          </span>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const liveConfig = loadExecutionConfig("live");
  const demoConfigured = isAccountConfigured("demo");
  const demoConfig = demoConfigured ? loadExecutionConfig("demo") : null;
  const minSamples = minCalibrationSamples();
  const calibration = getConfidenceCalibration(tradeJournal.all(), minSamples);

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
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Confidence calibration <span className="normal-case text-zinc-600">(measurement only — not wired into sizing)</span>
          </h2>
          <p className="mb-2 text-xs text-zinc-500">
            Real historical performance per confidence tier, so &quot;95% confidence&quot; can be checked against what actually happened
            instead of trusted as a probability. Confidence-weighted sizing will only ever use these numbers once a tier has enough
            samples to trust — never the raw AI score alone.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {calibration.map((bucket) => (
              <CalibrationRow key={bucket.tier} bucket={bucket} minSamples={minSamples} />
            ))}
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
