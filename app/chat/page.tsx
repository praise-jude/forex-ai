import Link from "next/link";
import { ChatPanel } from "@/components/dashboard/ChatPanel";

export default function ChatPage() {
  return (
    <main className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold">JUDE Chat</h1>
          <p className="text-sm text-zinc-500">Ask about the market, positions, risk, or Autopilot -- or tell JUDE what to do.</p>
        </div>
        <Link href="/dashboard" className="rounded-md border border-white/10 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700">
          ← Dashboard
        </Link>
      </header>
      <div className="flex-1 p-5">
        <div className="mx-auto h-[calc(100vh-140px)] max-w-3xl">
          <ChatPanel />
        </div>
      </div>
    </main>
  );
}
