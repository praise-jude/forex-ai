import { useEffect, useRef, useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";
import type { CardStatus, ExecuteResponse } from "@/lib/market/executionClient";
import { predictionHeadline } from "@/lib/market/predictionLabel";
import type { Pair, PositionRiskLevel, PredictionUpdate, Signal, Timeframe } from "@/lib/market/types";
import {
  buildConfirmPhrase,
  buildCooldownAnnouncement,
  buildDailyLossAnnouncement,
  buildKillzoneAnnouncement,
  buildPositionRiskAnnouncement,
  buildPredictionAnnouncement,
  buildResultAnnouncement,
  buildSignalAnnouncement,
  parseVoiceCommand,
} from "@/lib/voice/grammar";
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

interface RiskStatusResponse {
  haltedForToday: boolean;
  cooldownUntil: number | null;
  maxConsecutiveLosses: number;
  maxDailyLossPct: number;
}

interface ConfirmationModeResponse {
  manualMode: "signal_only" | "confirm";
  proposalTtlSeconds: number;
}

interface SessionStatusResponse {
  isKillzone: boolean;
}

const ENGINE_MODE_POLL_MS = 7000;
const RISK_STATUS_POLL_MS = 7000;
// Killzone boundaries only ever move on a clock-hour edge (see sessions.ts) -- no need
// to poll anywhere near as often as price-driven state.
const SESSION_STATUS_POLL_MS = 30000;
// How long JUDE keeps listening after asking "would you like me to place this trade?"
// before giving up -- ambiguous/absent input must never execute, so a timeout always
// resolves to "not placed", never a fallback confirm.
const CONFIRM_LISTEN_WINDOW_MS = 30000;
const PUSH_TO_TALK_WINDOW_MS = 8000;
// Matches Dashboard.tsx's own "confirmation-mode" poll interval -- usePolledResource
// dedupes same-key subscribers onto whichever interval the first subscriber set, so
// keeping this the same value avoids the two callers silently disagreeing about it.
const CONFIRMATION_MODE_POLL_MS = 15000;
const DEFAULT_PROPOSAL_TTL_SECONDS = 120;

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
  /** Only the currently selected pair's prediction changes are ever spoken -- see
   * onPredictionChange. */
  selectedPair: Pair;
  /** Three signal engines (15m/30m/1h) run concurrently per pair now -- only the
   * currently selected timeframe's changes are spoken, same reasoning as selectedPair. */
  selectedTimeframe: Timeframe;
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
  onPredictionChange: (update: PredictionUpdate) => void;
  onPositionRisk: (event: { pair: Pair; direction: "long" | "short"; level: PositionRiskLevel; reason: string }) => void;
}

function manualAccount(mode: EngineMode): AccountKey {
  return mode === "demo" ? "demo" : "live";
}

export function useVoiceAssistant({
  statuses,
  executeSignal,
  selectedPair,
  selectedTimeframe,
}: UseVoiceAssistantOptions): VoiceAssistantState {
  // Starts from DEFAULT_VOICE_SETTINGS on both server and first client render (avoids a
  // hydration mismatch), then swaps in the real localStorage value post-mount.
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [engineStatus, setEngineStatus] = useState<VoiceEngineStatus>("idle");
  const [lastMessage, setLastMessage] = useState("");
  const [pendingSignal, setPendingSignal] = useState<Signal | null>(null);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  // Shared with EngineModeControl.tsx (same "engine-mode" key) and RiskGuardianBanner.tsx
  // (same "risk-status" key) -- usePolledResource dedupes what were three independent
  // pollers hitting the same two endpoints down to one request per endpoint per tick.
  const { data: engineMode } = usePolledResource<EngineModeResponse>(
    "engine-mode",
    () => fetch("/api/engine-mode").then((res) => res.json()),
    ENGINE_MODE_POLL_MS
  );
  const { data: riskStatus } = usePolledResource<RiskStatusResponse>(
    "risk-status",
    () => fetch("/api/risk-status").then((res) => res.json()),
    RISK_STATUS_POLL_MS
  );
  // Shared with Dashboard.tsx's own "confirmation-mode" poll (same key, deduped).
  const { data: confirmationMode } = usePolledResource<ConfirmationModeResponse>(
    "confirmation-mode",
    () => fetch("/api/confirmation-mode").then((res) => res.json()),
    CONFIRMATION_MODE_POLL_MS
  );
  const { data: sessionStatus } = usePolledResource<SessionStatusResponse>(
    "session-status",
    () => fetch("/api/session-status").then((res) => res.json()),
    SESSION_STATUS_POLL_MS
  );

  const engineRef = useRef<VoiceEngine | null>(null);
  if (!engineRef.current && typeof window !== "undefined") {
    engineRef.current = new VoiceEngine({ onStatusChange: setEngineStatus });
  }

  const queueRef = useRef<Signal[]>([]);
  const pendingSignalRef = useRef<Signal | null>(null);
  const listenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Independent of listenTimerRef -- the listen window only ever starts in
  // trade_assistant mode with confirmationMode !== "button_only" (see announceNext),
  // so a pendingSignal in button_only mode previously had NO expiration at all. This
  // timer enforces the same server-side TTL (confirmationMode.ts's proposalTtlSeconds)
  // regardless of listen-window state, matching what the execute route itself already
  // enforces.
  const expirationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const engineModeRef = useRef(engineMode);
  engineModeRef.current = engineMode;
  const confirmationModeRef = useRef(confirmationMode);
  confirmationModeRef.current = confirmationMode;
  const selectedPairRef = useRef(selectedPair);
  selectedPairRef.current = selectedPair;
  const selectedTimeframeRef = useRef(selectedTimeframe);
  selectedTimeframeRef.current = selectedTimeframe;
  // Previous poll's guardian state -- compared against each new poll to speak only on the
  // moment a cooldown/halt actually trips, not on every single poll while it stays active.
  const prevRiskStatusRef = useRef<RiskStatusResponse | null>(null);
  // Same "compare against the previous poll, speak only on an actual flip" shape as
  // prevRiskStatusRef -- undefined (not a boolean) until the first poll resolves, so
  // landing on the dashboard mid-killzone doesn't misfire an "opened" announcement.
  const prevIsKillzoneRef = useRef<boolean | undefined>(undefined);
  // Previous *headline* per (pair, timeframe) composite key -- not raw confidence (a
  // same-tier confidence wobble, e.g. 91%->93%, must not re-announce), and not per-pair
  // alone anymore now that three signal engines (15m/30m/1h) run concurrently per pair --
  // collapsing them into one remembered headline per pair would misfire the moment the
  // timeframe selector changes (comparing e.g. the 1h headline against the last-remembered
  // 15m one). Tracked for every pair+timeframe so switching back to one that changed while
  // in the background doesn't misfire on return, and so a background change is still
  // recorded (silently) rather than announced later as if it had just happened.
  const prevPredictionRef = useRef<Partial<Record<string, string>>>({});

  useEffect(() => {
    // Swaps in the real localStorage value post-mount, deliberately -- reading it during
    // the initial render would desync the client's first render from the server-rendered
    // (localStorage-less) HTML and trip a hydration mismatch instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadVoiceSettings());
  }, []);

  // The JUDE AI Trade Guardian's proactive side -- speaks the moment a cooldown or daily
  // halt trips, not just reactively the next time a blocked execution attempt happens to
  // surface the same code (see blockedReasonSpeech in grammar.ts for that reactive path).
  // Fires once per riskStatus update (same cadence the old dedicated poll had, since
  // usePolledResource's shared "risk-status" cache produces a fresh object each tick).
  useEffect(() => {
    if (!riskStatus) return;
    const prev = prevRiskStatusRef.current;
    if (settingsRef.current.voiceMode !== "off") {
      if (riskStatus.haltedForToday && !prev?.haltedForToday) {
        speak(buildDailyLossAnnouncement(riskStatus.maxDailyLossPct));
      } else if (riskStatus.cooldownUntil && riskStatus.cooldownUntil !== prev?.cooldownUntil) {
        const cooldownMinutes = Math.round((riskStatus.cooldownUntil - Date.now()) / 60_000);
        speak(buildCooldownAnnouncement(riskStatus.maxConsecutiveLosses, Math.max(1, cooldownMinutes)));
      }
    }
    prevRiskStatusRef.current = riskStatus;
  }, [riskStatus]);

  // Mirrors the risk-status effect above, but for the killzone open/close boundary (see
  // sessionAlerts.ts's server-side push-notification counterpart) -- purely
  // informational, narrates the exact "why is nothing firing" confusion point rather
  // than changing anything about execution.
  useEffect(() => {
    if (!sessionStatus) return;
    const prev = prevIsKillzoneRef.current;
    if (settingsRef.current.voiceMode !== "off" && prev !== undefined && sessionStatus.isKillzone !== prev) {
      speak(buildKillzoneAnnouncement(sessionStatus.isKillzone));
    }
    prevIsKillzoneRef.current = sessionStatus.isKillzone;
  }, [sessionStatus]);

  function clearListenTimer() {
    if (listenTimerRef.current) {
      clearTimeout(listenTimerRef.current);
      listenTimerRef.current = null;
    }
  }

  function clearExpirationTimer() {
    if (expirationTimerRef.current) {
      clearTimeout(expirationTimerRef.current);
      expirationTimerRef.current = null;
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

    const ttlSeconds = confirmationModeRef.current?.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;
    expirationTimerRef.current = setTimeout(() => {
      if (pendingSignalRef.current?.id === next.id) {
        resolvePending("That trade proposal has expired. No trade has been placed.");
      }
    }, ttlSeconds * 1000);

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
    clearExpirationTimer();
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

  /**
   * A passive status readout, not an actionable trade opportunity -- deliberately
   * bypasses the FIFO queue/pendingSignalRef machinery above (that exists to guarantee
   * a real trade opportunity is never dropped or talked over), since only the *latest*
   * headline for the selected pair+timeframe ever matters here. Edge-triggered on the
   * headline label only (STRONG BUY/BUY/NEUTRAL/SELL/STRONG SELL/NO TRADE), so a
   * same-tier confidence wobble stays silent, and never announces for a pair/timeframe
   * that isn't currently selected -- VoiceEngine.speak()'s own internal queue still
   * serializes this after whatever's currently being said, so it can't talk over a
   * pending trade confirmation.
   */
  function onPredictionChange(update: PredictionUpdate) {
    const label = predictionHeadline(update.evaluation);
    const key = `${update.pair}|${update.timeframe}`;
    const prev = prevPredictionRef.current[key];
    prevPredictionRef.current[key] = label;
    if (prev === label) return;
    if (settingsRef.current.voiceMode === "off") return;
    if (update.pair !== selectedPairRef.current) return;
    if (update.timeframe !== selectedTimeframeRef.current) return;
    speak(buildPredictionAnnouncement(update));
  }

  /**
   * A "position_risk" SSE event only ever arrives on a genuine level change -- the
   * server (positionRiskStore.ts) already dedupes repeats, so there's no extra
   * edge-detection needed here, unlike onPredictionChange above. Bypasses the FIFO
   * queue for the same reason that one does: this is a passive status readout, not a
   * trade opportunity that must never be dropped. Never speaks "aligned" -- recovering
   * to aligned is shown on the dashboard, but isn't worth interrupting the user for.
   */
  function onPositionRisk(event: { pair: Pair; direction: "long" | "short"; level: PositionRiskLevel; reason: string }) {
    if (settingsRef.current.voiceMode === "off") return;
    if (event.level === "aligned") return;
    speak(buildPositionRiskAnnouncement(event.pair, event.direction, event.level, event.reason));
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
      clearExpirationTimer();
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
    onPredictionChange,
    onPositionRisk,
  };
}
