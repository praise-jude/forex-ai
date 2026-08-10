import Link from "next/link";
import { ChatPanel } from "@/components/dashboard/ChatPanel";

export default function ChatPage() {
  return (
    <main className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h1 className="text-lg font-semibold">JUDE Chat</h1>
          <p className="text-sm text-zinc-500">Ask about the market, positions, risk, or Autopilot -- or tell JUDE what to do.</p>
        </div>
        <Link
          href="/dashboard"
          className="self-start rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 sm:self-auto"
        >
          ← Dashboard
        </Link>
      </header>
      {/* flex-1 min-h-0 (not a vh-based calc) so this fills whatever's left below the
          header regardless of how tall the header wraps to on a narrow screen -- ChatPanel
          itself is h-full, so it always exactly fills this remaining space. */}
      <div className="min-h-0 flex-1 p-3 sm:p-5">
        <div className="mx-auto h-full max-w-3xl">
          <ChatPanel />
        </div>
      </div>
    </main>
  );
}
