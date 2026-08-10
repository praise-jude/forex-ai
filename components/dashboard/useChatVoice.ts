import { useEffect, useRef, useState } from "react";
import { VoiceEngine, type VoiceEngineStatus } from "@/lib/voice/voiceEngine";

// Generous compared to the dashboard's own push-to-talk window (8s) -- a chat message is
// often a longer, more conversational sentence than a one-word trade confirmation.
const PUSH_TO_TALK_WINDOW_MS = 15000;

export interface ChatVoiceState {
  engineStatus: VoiceEngineStatus;
  voiceOn: boolean;
  toggleVoice: () => void;
  speakIfEnabled: (text: string) => void;
  cancelSpeech: () => void;
  pushToTalk: (onTranscript: (transcript: string) => void) => void;
  micPermissionDenied: boolean;
  sttSupported: boolean;
  ttsSupported: boolean;
}

export function useChatVoice(): ChatVoiceState {
  const [engineStatus, setEngineStatus] = useState<VoiceEngineStatus>("idle");
  const [voiceOn, setVoiceOn] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const [capabilities, setCapabilities] = useState({ stt: false, tts: false });

  // A lazy useState initializer (not useRef) so the instance is never read/assigned
  // during render itself -- VoiceEngine's own constructor already feature-detects
  // `window`/speechSynthesis internally, so it's safe to construct even during an SSR
  // pass (it just yields a fully-inert, unsupported-everything instance there).
  const [engine] = useState<VoiceEngine>(() => new VoiceEngine({ onStatusChange: setEngineStatus }));

  // Mirrors `voiceOn` into a ref so the (event-handler-only) speakIfEnabled below always
  // reads the latest value without becoming a stale closure -- synced via an effect
  // rather than assigned inline during render.
  const voiceOnRef = useRef(voiceOn);
  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only feature detection (Web Speech API support), not state derivable from render.
    setCapabilities({ stt: engine.isSttSupported(), tts: engine.isTtsSupported() });
  }, [engine]);

  function speakIfEnabled(text: string): void {
    if (voiceOnRef.current) void engine.speak(text);
  }

  function cancelSpeech(): void {
    engine.cancelSpeech();
  }

  function toggleVoice(): void {
    setVoiceOn((prev) => {
      if (prev) engine.cancelSpeech();
      return !prev;
    });
  }

  function pushToTalk(onTranscript: (transcript: string) => void): void {
    if (!engine.isSttSupported()) return;
    engine.listenOnce(PUSH_TO_TALK_WINDOW_MS).then((outcome) => {
      if ("transcript" in outcome) {
        onTranscript(outcome.transcript);
        return;
      }
      if (outcome.error === "not-allowed") setMicPermissionDenied(true);
    });
  }

  return {
    engineStatus,
    voiceOn,
    toggleVoice,
    speakIfEnabled,
    cancelSpeech,
    pushToTalk,
    micPermissionDenied,
    sttSupported: capabilities.stt,
    ttsSupported: capabilities.tts,
  };
}
