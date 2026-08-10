import { chatStore } from "@/lib/chat/chatStore";
import { runChatTurn } from "@/lib/chat/engine";

export const runtime = "nodejs";

/** Full persisted conversation, for the chat UI's initial load on both web and mobile. */
export async function GET() {
  return Response.json({ messages: chatStore.all() });
}

/**
 * POST /api/chat {message} -> {reply}. Gated by the existing proxy.ts password
 * middleware like every other route (not in PUBLIC_PATHS) -- no special-casing needed.
 * The Authorization header on this same request is forwarded to any self-referential
 * calls the chat's action tools make back into this server (see lib/chat/tools.ts).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim();
  if (!message) {
    return Response.json({ error: "invalid_request", message: "'message' (non-empty string) is required" }, { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const authHeader = request.headers.get("authorization");

  try {
    const reply = await runChatTurn(message, origin, authHeader);
    return Response.json({ reply });
  } catch (error) {
    console.error("[chat] turn failed:", error);
    return Response.json(
      { error: "chat_failed", message: error instanceof Error ? error.message : "chat turn failed" },
      { status: 502 }
    );
  }
}
