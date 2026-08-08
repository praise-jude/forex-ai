import { useEffect, useRef, useState } from "react";
import type { CardStatus, ExecuteResponse } from "@/lib/market/executionClient";
import type { Pair, Signal } from "@/lib/market/types";
import { buildConfirmPhrase, buildResultAnnouncement, buildSignalAnnouncement, parseVoiceCommand } from "@/lib/voice/grammar";
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, saveVoiceSettings, type VoiceSettings } from "@/lib/voice/settings";
import { VoiceEngine, type VoiceEngineStatus } from "@/lib/voice/voiceEngine";

type EngineMode = "analysis" | "demo" | "live";
type AccountKey = "live" | "demo";

interface EngineModeResponse {
  mode: EngineMode;
  demoConfigured: boolean;
  riskPerTradePct: number;
}

interface PositionsResponse {
  positions: { pair: Pair; direction: "long" | "short"; profit: number }[];
}

const ENGINE_MODE_POLL_MS = 7000;
// How long JUDE keeps listening after asking "would you like me to place this trade?"
// before giving up -- ambiguous/absent input must never execute, so a timeout always
// resolves to "not placed", never a fallback confirm.
const CONFIRM_LISTEN_WINDOW_MS = 30000;
const PUSH_TO_TALK_WINDOW_MS = 8000;

export type VoiceStatus = "disabled" | "unavailable" | "ready" | "speaking" | "listening";

export interface UseVoiceAssistantOptions {
  /** Lifted from Dashboard.tsx -- the same map SignalsPanel renders from, so JUDE narrates
   * the real outcome no matter which control (voice, the panel's Confirm button, or the
   * plain per-card Buy/Sell button) actually triggered the execution. */
  statuses: Record<string, CardStatus>;
  /** The exact same function passed to SignalsPanel -- voice execution is never a
   * separate code path from the manual button, so it can never bypass the backend's
   * risk checks. */
  executeSignal: (signal: Signal) => Promise<ExecuteResponse>;
}

export interface VoiceAssistantState {
  status: VoiceStatus;
  lastMessage: string;
  pendingSignal: Signal | null;
  settings: VoiceSettings;
  sttSupported: boolean;
  micPermissionDenied: boolean;
  updateSettings: (patch: Partial<VoiceSettings>) => void;
  confirmPending: () => void;
  declinePending: () => void;
  pushToTalk: () => void;
  onSignal: (signal: Signal) => void;
}

function manualAccount(mode: EngineMode): AccountKey {
  return mode === "demo" ? "demo" : "live";
}

export function useVoiceAssistant({ statuses, executeSignal }: UseVoiceAssistantOptions): VoiceAssistantState {
  // Starts from DEFAULT_VOICE_SETTINGS on both server and first client render (avoids a
  // hydration mismatch), then swaps in the real localStorage value post-mount.
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [engineStatus, setEngineStatus] = useState<VoiceEngineStatus>("idle");
  const [lastMessage, setLastMessage] = useState("");
  const [pendingSignal, setPendingSignal] = useState<Signal | null>(null);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const [engineMode, setEngineModeState] = useState<EngineModeResponse | null>(null);

  const engineRef = useRef<VoiceEngine | null>(null);
  if (!engineRef.current && typeof window !== "undefined") {
    engineRef.current = new VoiceEngine({ onStatusChange: setEngineStatus });
  }

  const queueRef = useRef<Signal[]>([]);
  const pendingSignalRef = useRef<Signal | null>(null);
  const listenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const engineModeRef = useRef(engineMode);
  engineModeRef.current = engineMode;

  useEffect(() => {
    // Swaps in the real localStorage value post-mount, deliberately -- reading it during
    // the initial render would desync the client's first render from the server-rendered
    // (localStorage-less) HTML and trip a hydration mismatch instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadVoiceSettings());
  }, []);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      fetch("/api/engine-mode")
        .then((res) => res.json())
        .then((json: EngineModeResponse) => {
          if (!cancelled) setEngineModeState(json);
        })
        .catch(() => {
          // Best-effort; keep the last known mode rather than flashing an error.
        });
    }
    poll();
    const pollId = setInterval(poll, ENGINE_MODE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, []);

  function clearListenTimer() {
    if (listenTimerRef.current) {
      clearTimeout(listenTimerRef.current);
      listenTimerRef.current = null;
    }
  }

  function speak(text: string): Promise<void> {
    setLastMessage(text);
    return engineRef.current?.speak(text) ?? Promise.resolve();
  }

  function announceNext() {
    if (pendingSignalRef.current) return; // already announcing/awaiting one -- FIFO, no talking over itself
    const next = queueRef.current.shift();
    if (!next) return;

    pendingSignalRef.current = next;
    setPendingSignal(next);

    const riskPerTradePct = engineModeRef.current?.riskPerTradePct ?? 1;
    speak(buildSignalAnnouncement(next, riskPerTradePct)).then(() => {
      const current = settingsRef.current;
      if (current.voiceMode === "trade_assistant" && current.confirmationMode !== "button_only") {
        startListenWindow(CONFIRM_LISTEN_WINDOW_MS);
      }
    });
  }

  function resolvePending(message: string) {
    pendingSignalRef.current = null;
    setPendingSignal(null);
    clearListenTimer();
    speak(message).then(announceNext);
  }

  function confirmPending() {
    const signal = pendingSignalRef.current;
    if (!signal) return;
    clearListenTimer();
    // Resolution (speaking the fill/reject/blocked result and moving to the next queued
    // signal) happens in the `statuses` watcher effect below, not here -- that effect
    // fires for ANY path that resolves this signal's status, not just this one.
    executeSignal(signal);
  }

  function declinePending() {
    if (!pendingSignalRef.current) return;
    resolvePending("Okay, I won't place that trade.");
  }

  async function triggerEmergencyStop() {
    const mode = engineModeRef.current?.mode ?? "analysis";
    try {
      await fetch("/api/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause", account: manualAccount(mode) }),
      });
      speak("Trading has been disabled. No new trades will be placed.");
    } catch {
      speak("I tried to disable trading but couldn't reach the server. Please use the Stop Robot button instead.");
    }
  }

  async function answerProfitQuery() {
    try {
      const res = await fetch("/api/positions");
      const data: PositionsResponse = await res.json();
      if (data.positions.length === 0) {
        speak("You have no open positions.");
        return;
      }
      const total = data.positions.reduce((sum, p) => sum + p.profit, 0);
      speak(`Your current open profit is ${total.toFixed(2)}.`);
    } catch {
      speak("I couldn't reach the server to check your profit.");
    }
  }

  async function answerPositionsQuery() {
    try {
      const res = await fetch("/api/positions");
      const data: PositionsResponse = await res.json();
      if (data.positions.length === 0) {
        speak("You have no open trades.");
        return;
      }
      const list = data.positions.map((p) => `${p.pair.replace("/", "")} ${p.direction}`).join(", ");
      speak(`You have ${data.positions.length} open ${data.positions.length === 1 ? "trade" : "trades"}: ${list}.`);
    } catch {
      speak("I couldn't reach the server to check your open trades.");
    }
  }

  function handleTranscript(transcript: string) {
    const pending = pendingSignalRef.current;
    const expected = pending ? buildConfirmPhrase(pending) : null;
    const command = parseVoiceCommand(transcript, expected);

    switch (command.kind) {
      case "hard_confirm":
        if (!pending) return;
        if (settingsRef.current.confirmationMode === "button_only") {
          speak("Voice confirmation is off -- use the Confirm button.").then(() => startListenWindow(CONFIRM_LISTEN_WINDOW_MS));
          return;
        }
        confirmPending();
        return;
      case "decline":
        if (pending) declinePending();
        return;
      case "soft_confirm":
        if (pending) {
          speak(`I need a clear confirmation. Please say the exact phrase: "${buildConfirmPhrase(pending)}" to place this trade.`).then(
            () => startListenWindow(CONFIRM_LISTEN_WINDOW_MS)
          );
        }
        return;
      case "emergency_stop":
        triggerEmergencyStop();
        return;
      case "query_profit":
        answerProfitQuery();
        return;
      case "query_positions":
        answerPositionsQuery();
        return;
      case "query_autopilot_status": {
        const mode = engineModeRef.current?.mode;
        speak(mode && mode !== "analysis" ? "Yes, autopilot is active." : "No, autopilot is not active.");
        return;
      }
      case "unrecognized":
        speak(pending ? "I need a clear confirmation. No trade has been placed." : "I didn't understand that.").then(() => {
          if (pending) startListenWindow(CONFIRM_LISTEN_WINDOW_MS);
        });
        return;
    }
  }

  function startListenWindow(timeoutMs: number) {
    clearListenTimer();
    const engine = engineRef.current;
    if (!engine || !engine.isSttSupported()) return;

    engine.listenOnce(timeoutMs).then((outcome) => {
      clearListenTimer();
      if ("transcript" in outcome) {
        handleTranscript(outcome.transcript);
        return;
      }
      if (outcome.error === "not-allowed") {
        setMicPermissionDenied(true);
        return;
      }
      // Timeout/no-speech/etc while a trade is awaiting confirmation: never execute on
      // ambiguous or absent input.
      if (pendingSignalRef.current) {
        resolvePending("I didn't hear a confirmation. That trade was not placed.");
      }
    });
  }

  function pushToTalk() {
    const engine = engineRef.current;
    if (!engine || !engine.isSttSupported() || settingsRef.current.voiceMode === "off") return;
    startListenWindow(PUSH_TO_TALK_WINDOW_MS);
  }

  function onSignal(signal: Signal) {
    if (settingsRef.current.voiceMode === "off") return;
    queueRef.current.push(signal);
    announceNext();
  }

  function updateSettings(patch: Partial<VoiceSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveVoiceSettings(next);
      return next;
    });
  }

  // Fires when the currently-tracked signal's execution resolves, however it was
  // triggered (voice hard-confirm, the voice panel's own Confirm button, or the plain
  // SignalsPanel Buy/Sell button) -- one place narrates the real result for all of them.
  useEffect(() => {
    const signal = pendingSignal;
    if (!signal) return;
    const status = statuses[signal.id];
    if (status?.state === "done") {
      pendingSignalRef.current = null;
      // This effect's real job is the side effect on the next line -- speaking the result
      // through the browser's TTS API, a genuine external system, not a value derivable
      // from other React state -- so it belongs in an effect rather than during render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingSignal(null);
      clearListenTimer();
      speak(buildResultAnnouncement(signal, status.result)).then(announceNext);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, pendingSignal]);

  const engine = engineRef.current;
  const sttSupported = engine?.isSttSupported() ?? false;

  let status: VoiceStatus;
  if (settings.voiceMode === "off") status = "disabled";
  else if (engine && !engine.isTtsSupported()) status = "unavailable";
  else if (engineStatus === "speaking") status = "speaking";
  else if (engineStatus === "listening") status = "listening";
  else status = "ready";

  return {
    status,
    lastMessage,
    pendingSignal,
    settings,
    sttSupported,
    micPermissionDenied,
    updateSettings,
    confirmPending,
    declinePending,
    pushToTalk,
    onSignal,
  };
}
