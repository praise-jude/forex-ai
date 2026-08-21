import { chatStore } from "@/lib/chat/chatStore";
import { runChatTurn } from "@/lib/chat/engine";

export const runtime = "nodejs";

/** Full persisted conversation, for the chat UI's initial load on both web and mobile. */
export async function GET() {
  return Response.json({ messages: chatStore.all() });
}

/**
 * Never surface a raw provider error (a Gemini SDK error's own `.message` can be the
 * entire raw JSON response body, including internal quota/project details) directly to
 * the chat UI -- the full error is still logged server-side for diagnosis, this is only
 * what reaches the user. Recognizes the one error shape worth explaining specifically
 * (the free-tier daily request quota); everything else gets a plain, honest fallback.
 */
function friendlyChatErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/RESOURCE_EXHAUSTED|quota/i.test(raw)) {
    return "JUDE has hit its free daily message limit for today. It resets on its own -- try again later or tomorrow.";
  }
  return "JUDE couldn't respond just now. Try again in a moment.";
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
    return Response.json({ error: "chat_failed", message: friendlyChatErrorMessage(error) }, { status: 502 });
  }
}
