export type VoiceMode = "off" | "notifications" | "trade_assistant";
export type ConfirmationMode = "voice_only" | "voice_and_button" | "button_only";

export interface VoiceSettings {
  voiceMode: VoiceMode;
  confirmationMode: ConfirmationMode;
}

const VOICE_MODES: VoiceMode[] = ["off", "notifications", "trade_assistant"];
const CONFIRMATION_MODES: ConfirmationMode[] = ["voice_only", "voice_and_button", "button_only"];

// "trade_assistant" / "voice_and_button" are the spec's stated defaults: JUDE speaks and
// listens, but the visual Confirm button always stays available alongside voice.
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceMode: "trade_assistant",
  confirmationMode: "voice_and_button",
};

const STORAGE_KEY = "forex-ai.voiceSettings";

/** SSR-safe: returns the defaults on the server and on any localStorage failure (private
 * browsing, corrupted JSON, disabled storage) rather than throwing. */
export function loadVoiceSettings(): VoiceSettings {
  if (typeof window === "undefined") return DEFAULT_VOICE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      voiceMode: VOICE_MODES.includes(parsed.voiceMode as VoiceMode) ? (parsed.voiceMode as VoiceMode) : DEFAULT_VOICE_SETTINGS.voiceMode,
      confirmationMode: CONFIRMATION_MODES.includes(parsed.confirmationMode as ConfirmationMode)
        ? (parsed.confirmationMode as ConfirmationMode)
        : DEFAULT_VOICE_SETTINGS.confirmationMode,
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort -- e.g. Safari private browsing throws on write.
  }
}
