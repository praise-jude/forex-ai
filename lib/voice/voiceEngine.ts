export type VoiceEngineStatus = "idle" | "speaking" | "listening";

export type ListenOutcome =
  | { transcript: string }
  | { error: "not-allowed" | "no-speech" | "aborted" | "audio-capture" | "network" | "timeout" | "other" };

interface VoiceEngineCallbacks {
  onStatusChange?: (status: VoiceEngineStatus) => void;
}

function mapErrorCode(code: string): ListenOutcome {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return { error: "not-allowed" };
    case "no-speech":
      return { error: "no-speech" };
    case "aborted":
      return { error: "aborted" };
    case "audio-capture":
      return { error: "audio-capture" };
    case "network":
      return { error: "network" };
    default:
      return { error: "other" };
  }
}

/**
 * Thin client-only wrapper around the browser's SpeechSynthesis (TTS) and SpeechRecognition
 * (STT) APIs. Constructed lazily -- every browser API access is feature-detected so this
 * degrades to a no-op (never throws) when speech isn't supported (e.g. Firefox has no STT)
 * or during SSR (`window` undefined).
 */
export class VoiceEngine {
  private synth: SpeechSynthesis | null;
  private RecognitionCtor: (new () => SpeechRecognition) | null;
  private activeRecognition: SpeechRecognition | null = null;
  private speakQueue: Promise<void> = Promise.resolve();
  private callbacks: VoiceEngineCallbacks;

  constructor(callbacks: VoiceEngineCallbacks = {}) {
    this.callbacks = callbacks;
    this.synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
    this.RecognitionCtor = typeof window !== "undefined" ? (window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null) : null;
  }

  isTtsSupported(): boolean {
    return this.synth !== null;
  }

  isSttSupported(): boolean {
    return this.RecognitionCtor !== null;
  }

  /** Queued so overlapping calls never talk over each other -- resolves once this
   * utterance finishes (or immediately if TTS isn't supported). */
  speak(text: string): Promise<void> {
    if (!this.synth) return Promise.resolve();
    const synth = this.synth;

    this.speakQueue = this.speakQueue.then(
      () =>
        new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1;
          utterance.pitch = 1;
          utterance.onstart = () => this.callbacks.onStatusChange?.("speaking");
          const finish = () => {
            this.callbacks.onStatusChange?.("idle");
            resolve();
          };
          utterance.onend = finish;
          utterance.onerror = finish;
          synth.speak(utterance);
        })
    );
    return this.speakQueue;
  }

  /** Listens for a single utterance (non-continuous), auto-stopping after `timeoutMs` if
   * nothing is recognized. Only ever one recognition session active at a time -- a new
   * call aborts whatever's currently listening first. */
  listenOnce(timeoutMs: number): Promise<ListenOutcome> {
    if (!this.RecognitionCtor) return Promise.resolve({ error: "other" });
    this.stopListening();

    const Recognition = this.RecognitionCtor;
    return new Promise((resolve) => {
      const recognition = new Recognition();
      this.activeRecognition = recognition;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.lang = "en-US";

      let settled = false;
      const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);

      const finish = (outcome: ListenOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.callbacks.onStatusChange?.("idle");
        if (this.activeRecognition === recognition) this.activeRecognition = null;
        try {
          recognition.stop();
        } catch {
          // already stopped
        }
        resolve(outcome);
      };

      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript ?? "";
        finish(transcript ? { transcript } : { error: "no-speech" });
      };
      recognition.onerror = (event) => finish(mapErrorCode(event.error));
      recognition.onend = () => finish({ error: "no-speech" });

      this.callbacks.onStatusChange?.("listening");
      try {
        recognition.start();
      } catch {
        finish({ error: "other" });
      }
    });
  }

  stopListening(): void {
    this.activeRecognition?.abort();
    this.activeRecognition = null;
  }

  cancelSpeech(): void {
    this.synth?.cancel();
  }
}
