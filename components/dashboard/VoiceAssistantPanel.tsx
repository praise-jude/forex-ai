"use client";

import { formatPrice } from "@/lib/market/format";
import type { VoiceAssistantState, VoiceStatus } from "./useVoiceAssistant";
import { VoiceSettingsMenu } from "./VoiceSettingsMenu";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  disabled: "DISABLED",
  unavailable: "UNAVAILABLE",
  ready: "READY",
  speaking: "SPEAKING",
  listening: "LISTENING",
};

const STATUS_DOT_CLASSES: Record<VoiceStatus, string> = {
  disabled: "bg-zinc-600",
  unavailable: "bg-amber-400",
  ready: "bg-zinc-500",
  speaking: "bg-sky-400 animate-pulse",
  listening: "bg-emerald-400 animate-pulse",
};

export function VoiceAssistantPanel(voice: VoiceAssistantState) {
  const { status, lastMessage, pendingSignal, settings, sttSupported, micPermissionDenied, updateSettings, confirmPending, declinePending, pushToTalk } =
    voice;

  const showMicButton = settings.voiceMode !== "off" && sttSupported && !micPermissionDenied;

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT_CLASSES[status]}`} />
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">JUDE Voice Assistant</span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">{STATUS_LABEL[status]}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {showMicButton && (
            <button
              type="button"
              onClick={pushToTalk}
              disabled={status === "speaking" || status === "listening"}
              className="rounded-md border border-white/10 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Push to talk"
            >
              🎙
            </button>
          )}
          <VoiceSettingsMenu settings={settings} onChange={updateSettings} />
        </div>
      </div>

      {settings.voiceMode !== "off" && !sttSupported && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-400">
          VOICE CONTROL UNAVAILABLE — this browser doesn&apos;t support speech recognition. Announcements still speak; use the Confirm
          button to place trades.
        </p>
      )}
      {micPermissionDenied && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-400">
          VOICE CONTROL UNAVAILABLE — microphone access was denied. Use the Confirm button to place trades.
        </p>
      )}

      {lastMessage && settings.voiceMode !== "off" && (
        <p className="mt-2.5 text-xs text-zinc-400">
          <span className="font-semibold text-zinc-300">JUDE:</span> &ldquo;{lastMessage}&rdquo;
        </p>
      )}

      {pendingSignal && (
        <div className="mt-3 rounded-lg border border-sky-800/60 bg-sky-950/30 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sky-400">JUDE Voice Confirmation</p>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-zinc-100">{pendingSignal.pair}</span>
            <span className={`text-sm font-bold ${pendingSignal.direction === "long" ? "text-emerald-400" : "text-rose-400"}`}>
              {pendingSignal.direction === "long" ? "↑ BUY" : "↓ SELL"}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
            <div>
              <dt className="text-zinc-500">Entry</dt>
              <dd className="text-zinc-200">{formatPrice(pendingSignal.pair, pendingSignal.entry)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Stop loss</dt>
              <dd className="text-rose-400">{formatPrice(pendingSignal.pair, pendingSignal.stopLoss)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Take profit</dt>
              <dd className="text-emerald-400">{formatPrice(pendingSignal.pair, pendingSignal.takeProfit)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Risk/Reward</dt>
              <dd className="text-zinc-200">{pendingSignal.riskReward.toFixed(1)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Confidence</dt>
              <dd className="text-zinc-200">{Math.round(pendingSignal.confidence)}%</dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] text-zinc-500">Status: waiting for confirmation</p>
          {settings.confirmationMode !== "button_only" && showMicButton && (
            <p className="text-[11px] text-sky-400">
              Say &ldquo;yes&rdquo;, or the full phrase: &ldquo;CONFIRM {pendingSignal.direction === "long" ? "BUY" : "SELL"}{" "}
              {pendingSignal.pair.replace("/", "")}&rdquo;
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirmPending}
              className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
            >
              Confirm &amp; Place Trade
            </button>
            <button
              type="button"
              onClick={declinePending}
              className="flex-1 rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
