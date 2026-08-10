"use client";

import { useEffect, useRef, useState } from "react";
import { useChatVoice } from "./useChatVoice";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  time: number;
}

const QUICK_ACTIONS = [
  "Analyze the current market.",
  "Check my open trades.",
  "What's my risk status?",
  "Is autopilot active?",
];

/**
 * Text/voice chat with JUDE. Every reply comes from POST /api/chat, which is the only
 * thing that ever talks to the LLM -- this component just renders history and forwards
 * whatever the user typed or said, unmodified, as the message body. That's important:
 * the backend's confirm-phrase safety gate (lib/chat/tools.ts) checks the RAW message
 * text, so this component must never paraphrase, trim meaning from, or auto-complete
 * what the user actually said before sending it.
 */
export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const voice = useChatVoice();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/chat")
      .then((res) => res.json())
      .then((data: { messages: ChatMessage[] }) => setMessages(data.messages))
      .catch(() => {
        // Best-effort initial load -- an empty history just means the chat starts fresh.
      });
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setInput("");
    setError(null);
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: trimmed, time: Date.now() }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = (await res.json()) as { reply?: string; message?: string };
      if (!res.ok || !data.reply) {
        throw new Error(data.message ?? "Chat request failed.");
      }
      const reply = data.reply;
      setMessages((prev) => [...prev, { role: "assistant", content: reply, time: Date.now() }]);
      voice.speakIfEnabled(reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat request failed.");
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  return (
    <section className="flex h-full flex-col rounded-xl border border-white/10 bg-zinc-900">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              voice.engineStatus === "speaking"
                ? "bg-sky-400 animate-pulse"
                : voice.engineStatus === "listening"
                  ? "bg-emerald-400 animate-pulse"
                  : "bg-zinc-500"
            }`}
          />
          <h2 className="text-sm font-semibold text-zinc-100">JUDE Chat</h2>
        </div>
        {voice.ttsSupported && (
          <div className="flex items-center gap-1.5">
            {voice.voiceOn && voice.engineStatus === "speaking" && (
              <button
                type="button"
                onClick={voice.cancelSpeech}
                className="rounded-md border border-white/10 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
                title="Stop speaking"
              >
                ⏹
              </button>
            )}
            <button
              type="button"
              onClick={voice.toggleVoice}
              className={`rounded-md border border-white/10 px-2 py-1 text-xs transition ${
                voice.voiceOn ? "bg-sky-600 text-white hover:bg-sky-500" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
              title={voice.voiceOn ? "Voice replies on" : "Voice replies off"}
            >
              {voice.voiceOn ? "🔊" : "🔇"}
            </button>
          </div>
        )}
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-xs text-zinc-500">
            Ask JUDE about the market, your positions, risk status, or Autopilot -- e.g. &ldquo;What&apos;s the setup on gold right
            now?&rdquo;
          </p>
        )}
        <div className="flex flex-col gap-2.5">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === "user" ? "bg-sky-600 text-white" : "bg-zinc-800 text-zinc-100"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-500">JUDE is thinking…</div>
            </div>
          )}
        </div>
      </div>

      {error && <p className="mx-4 mb-2 rounded-md bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-400">{error}</p>}
      {voice.micPermissionDenied && (
        <p className="mx-4 mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-400">
          Microphone access was denied -- use the text box instead.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-white/10 px-4 py-2">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => void sendMessage(action)}
            disabled={sending}
            className="rounded-full border border-white/10 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-white/10 p-3">
        {voice.sttSupported && (
          <button
            type="button"
            onClick={() => voice.pushToTalk((transcript) => void sendMessage(transcript))}
            disabled={sending || voice.engineStatus === "listening"}
            className="rounded-md border border-white/10 bg-zinc-800 px-2.5 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Push to talk"
          >
            🎙
          </button>
        )}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message JUDE…"
          disabled={sending}
          className="flex-1 rounded-md border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
