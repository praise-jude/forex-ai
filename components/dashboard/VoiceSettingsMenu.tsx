"use client";

import { useState } from "react";
import type { ConfirmationMode, VoiceMode, VoiceSettings } from "@/lib/voice/settings";

const VOICE_MODE_OPTIONS: { value: VoiceMode; label: string; hint: string }[] = [
  { value: "off", label: "Voice off", hint: "JUDE never speaks or listens" },
  { value: "notifications", label: "Voice notifications", hint: "Speaks announcements only, never listens" },
  { value: "trade_assistant", label: "Voice trade assistant", hint: "Speaks and listens for confirmations" },
];

const CONFIRMATION_MODE_OPTIONS: { value: ConfirmationMode; label: string; hint: string }[] = [
  { value: "voice_only", label: "Voice only", hint: "Say the confirm phrase to place a trade" },
  { value: "voice_and_button", label: "Voice + button", hint: "Either voice or the Confirm button works" },
  { value: "button_only", label: "Button only", hint: "Voice confirm phrases are ignored" },
];

export function VoiceSettingsMenu({
  settings,
  onChange,
}: {
  settings: VoiceSettings;
  onChange: (patch: Partial<VoiceSettings>) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Voice assistant settings"
        className="rounded-md border border-white/10 bg-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-200"
      >
        ⚙
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-white/10 bg-zinc-900 p-3 shadow-2xl shadow-black/50">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Voice mode</p>
            <div className="mb-3 space-y-1">
              {VOICE_MODE_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-zinc-800">
                  <input
                    type="radio"
                    name="voiceMode"
                    checked={settings.voiceMode === option.value}
                    onChange={() => onChange({ voiceMode: option.value })}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-zinc-200">{option.label}</span>
                    <span className="block text-[10px] text-zinc-500">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Confirmation mode</p>
            <div className="space-y-1">
              {CONFIRMATION_MODE_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-zinc-800">
                  <input
                    type="radio"
                    name="confirmationMode"
                    checked={settings.confirmationMode === option.value}
                    onChange={() => onChange({ confirmationMode: option.value })}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-zinc-200">{option.label}</span>
                    <span className="block text-[10px] text-zinc-500">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
