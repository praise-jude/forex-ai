import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import { chatStore } from "./chatStore";
import { JUDE_SYSTEM_PROMPT } from "./systemPrompt";
import { buildTools, type ToolContext } from "./tools";

// Flash-Lite rather than plain Flash or Pro -- the free tier's daily request quota is
// tracked separately per model, and Flash's own quota turned out to be only 20
// requests/day (confirmed live: a real chat session hit a RESOURCE_EXHAUSTED 429 well
// within a single day of normal use). Flash-Lite's tool-calling round trip was verified
// working identically before switching. The "-latest" alias (rather than a pinned
// version like "gemini-3.6-flash") also means this never needs updating again as Google
// rotates model versions -- confirmed live that it currently resolves to
// gemini-3.5-flash-lite. Re-verify against the real API if this ever 404s or the quota
// error reappears.
const MODEL = "gemini-flash-lite-latest";
// A hard ceiling on the call-tool -> feed-result -> call-model-again loop below, so a
// model stuck calling tools forever can't hang a request indefinitely -- see the loop's
// own comment. No real JUDE turn should ever need more than a handful of tool calls.
const MAX_TOOL_ROUNDS = 8;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  // Lazy so a missing key only breaks /api/chat (mirrors the OPENAI_API_KEY pattern in
  // app/api/voice/transcribe/route.ts), not module load / every other route.
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function toGeminiRole(role: "user" | "assistant"): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

/**
 * Runs one chat turn: loads persisted history, appends the user's message, lets Gemini
 * call tools (built fresh, closed over the raw message -- see tools.ts) via a manual
 * call/respond loop (the Gemini SDK has no equivalent of Anthropic's toolRunner
 * convenience helper), then persists both turns and returns the assistant's reply text.
 */
export async function runChatTurn(rawUserMessage: string, requestOrigin: string, authHeader: string | null): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set on the server.");
  }

  const history = chatStore.all();
  const ctx: ToolContext = { rawUserMessage, origin: requestOrigin, authHeader };
  const tools = buildTools(ctx);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const functionDeclarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));

  const contents: Content[] = [
    ...history.map((m): Content => ({ role: toGeminiRole(m.role), parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: rawUserMessage }] },
  ];

  let replyText = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await getClient().models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: JUDE_SYSTEM_PROMPT,
        tools: [{ functionDeclarations }],
      },
    });

    // Read the real parts array (not just the .functionCalls convenience getter) so any
    // text the model produced alongside a tool call is preserved when echoing this turn
    // back as conversation history below.
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p): p is Part & { functionCall: NonNullable<Part["functionCall"]> } => Boolean(p.functionCall));

    if (calls.length === 0) {
      replyText = response.text ?? "";
      break;
    }

    contents.push({ role: "model", parts });

    const responseParts: Part[] = [];
    for (const { functionCall: call } of calls) {
      const tool = call.name ? toolsByName.get(call.name) : undefined;
      const resultText = tool ? await tool.run(call.args ?? {}) : JSON.stringify({ ok: false, error: "unknown_tool", message: `No tool named "${call.name}".` });
      responseParts.push({ functionResponse: { name: call.name, response: { result: resultText } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (!replyText) {
    replyText = "I wasn't able to finish that within the allowed number of steps -- try rephrasing or asking a narrower question.";
  }

  const now = Date.now();
  chatStore.append({ role: "user", content: rawUserMessage, time: now });
  chatStore.append({ role: "assistant", content: replyText, time: now });

  return replyText;
}
