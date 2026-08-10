export const runtime = "nodejs";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
// Keeps a single small audio clip (a spoken command, a few seconds) from turning into an
// unbounded upload -- this endpoint is authenticated (see proxy.ts) but still worth
// bounding before it's forwarded to a billed third-party API.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * Proxies a recorded voice command to OpenAI's Whisper transcription API. The API key
 * never reaches the mobile app -- it's read from the server's own env here, same
 * "secrets stay server-side" rule as MetaApi's token/account id. Returns 500 (not a
 * silent no-op) when unconfigured, matching the TradingView webhook's own pattern for an
 * optional feature that's off until explicitly set up.
 */
export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "voice_not_configured", message: "OPENAI_API_KEY is not set on the server." }, { status: 500 });
  }

  const incoming = await request.formData().catch(() => null);
  const audio = incoming?.get("audio");
  if (!(audio instanceof Blob)) {
    return Response.json({ error: "invalid_request", message: "multipart form field 'audio' (a file) is required" }, { status: 400 });
  }
  if (audio.size === 0) {
    return Response.json({ error: "invalid_request", message: "audio file is empty" }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "invalid_request", message: `audio file exceeds ${MAX_AUDIO_BYTES} bytes` }, { status: 400 });
  }

  const upstream = new FormData();
  upstream.set("file", audio, "command.m4a");
  upstream.set("model", "whisper-1");

  let response: Response;
  try {
    response = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });
  } catch (error) {
    return Response.json(
      { error: "upstream_error", message: error instanceof Error ? error.message : "failed to reach OpenAI" },
      { status: 502 }
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[voice] transcription failed (${response.status}): ${detail}`);
    // Surfaces the real upstream status/detail to the client instead of a generic
    // placeholder -- this is a single-operator app (the only person who'd ever see
    // this message is the operator debugging their own setup), not a boundary where
    // OpenAI's raw error needs to be hidden from an untrusted caller.
    return Response.json(
      { error: "transcription_failed", message: `OpenAI transcription request failed (${response.status}): ${detail.slice(0, 300)}` },
      { status: 502 }
    );
  }

  const json = (await response.json()) as { text?: string };
  return Response.json({ text: json.text ?? "" });
}
