import Anthropic from "@anthropic-ai/sdk";
import { chatStore } from "./chatStore";
import { JUDE_SYSTEM_PROMPT } from "./systemPrompt";
import { buildTools, type ToolContext } from "./tools";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 4096;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  // Lazy so a missing key only breaks /api/chat (mirrors the OPENAI_API_KEY pattern in
  // app/api/voice/transcribe/route.ts), not module load / every other route.
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Runs one chat turn: loads persisted history, appends the user's message, lets Claude
 * call tools (built fresh, closed over the raw message -- see tools.ts), then persists
 * both turns and returns the assistant's reply text.
 */
export async function runChatTurn(rawUserMessage: string, requestOrigin: string, authHeader: string | null): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  }

  const history = chatStore.all();
  const ctx: ToolContext = { rawUserMessage, origin: requestOrigin, authHeader };
  const tools = buildTools(ctx);

  const finalMessage = await getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: JUDE_SYSTEM_PROMPT,
    tools,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content }) as Anthropic.Beta.BetaMessageParam),
      { role: "user", content: rawUserMessage },
    ],
  });

  const replyText = finalMessage.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const now = Date.now();
  chatStore.append({ role: "user", content: rawUserMessage, time: now });
  chatStore.append({ role: "assistant", content: replyText, time: now });

  return replyText;
}
