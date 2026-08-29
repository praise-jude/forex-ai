import { getClient, MODEL } from "./engine";
import { chatStore } from "./chatStore";
import type { JournalEntry } from "../market/tradeJournal";

// Single-shot completion, deliberately NOT the tool-calling loop runChatTurn uses --
// every fact this needs is already in `entry` (the real JournalEntry just written),
// so there's nothing for JUDE to look up. Cheaper and simpler than a tool round trip,
// and can't accidentally call execute_trade or set_engine_mode from an automated
// trigger with no human behind it.
const RETROSPECTIVE_SYSTEM_PROMPT = `You are JUDE, writing a short, honest retrospective on ONE trade that just closed, for the user's own trade journal chat.

Ground rules:
- Use ONLY the facts given below. Never invent a reason, indicator reading, or market condition that isn't in the data.
- 2-4 sentences. Plain, direct, evidence-based -- the same voice as the rest of this app: no hype, no apologies, no "great job"/"unlucky" filler.
- Explain what likely worked or didn't, tying the OUTCOME (win/loss, R-multiple, close reason) back to the SETUP data (regime, setup quality, ADX/RSI, session, confluences, Signer B) -- that's the actual point of a retrospective, not just restating the numbers.
- Never promise future performance, never say a strategy "will" work next time -- at most note a real pattern if the data actually shows one.
- If setup-quality/confluence data is missing (an older entry, or a manual/synthetic trade), say only what the available fields actually support -- don't fill the gap with a guess.`;

// Exported for testing -- pure and side-effect-free, unlike generateTradeRetrospective
// itself (a real network call), so this is the part worth unit-testing directly: never
// invents a field the entry doesn't actually have.
export function formatEntryForPrompt(entry: JournalEntry): string {
  const lines: string[] = [
    `Pair: ${entry.pair}`,
    `Direction: ${entry.direction}`,
    `Entry: ${entry.entryPrice}, Exit: ${entry.exitPrice}`,
    `Profit: ${entry.profit.toFixed(2)} (account currency)`,
    `R-multiple: ${entry.rMultiple === null ? "unavailable" : entry.rMultiple.toFixed(2)}`,
    `Close reason: ${entry.reason}`,
  ];
  if (entry.context) {
    const c = entry.context;
    lines.push(`Engine: ${c.source ?? "unknown"}`);
    lines.push(`Market regime at entry: ${c.regime}`);
    lines.push(`Confidence at entry: ${c.confidence.toFixed(0)}/100`);
    if (c.setupQuality) {
      const q = c.setupQuality;
      lines.push(
        `Setup quality breakdown: SMC ${q.smc}/30, trend ${q.trend}/20, momentum ${q.momentum}/15, liquidity ${q.liquidity}/10, volatility ${q.volatility}/10, news ${q.newsRisk}/10, session ${q.session}/5 (total ${q.total}/100)`
      );
    }
    lines.push(`ADX at entry: ${c.adx.toFixed(1)}, RSI at entry: ${c.rsi.toFixed(1)}`);
    lines.push(`Signer B: ${c.signerBDirection} at ${c.signerBConfidence.toFixed(0)}%`);
    lines.push(`Session: ${c.session}, News: ${c.newsStatus}`);
    if (c.confluences && c.confluences.length > 0) lines.push(`Confluences present: ${c.confluences.join(", ")}`);
  } else {
    lines.push("No setup context available for this trade (older entry, or opened outside the app).");
  }
  return lines.join("\n");
}

/**
 * Generates and stores a real, LLM-written retrospective for one just-closed trade --
 * appended to the same chatStore the JUDE chat panel reads, so it shows up as a normal
 * assistant message next time the user opens chat. Fire-and-forget from the caller
 * (metaApiConnection.ts's onDealAdded), matching sendNotification's own "best effort,
 * never blocks the real risk-state/journal recording it runs alongside" posture -- a
 * failed generation here can never affect execution, risk state, or the journal entry
 * itself (already durably recorded before this is ever called).
 */
export async function generateTradeRetrospective(entry: JournalEntry): Promise<void> {
  if (!process.env.GEMINI_API_KEY) return; // same "silently no-op until configured" posture as runChatTurn

  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: formatEntryForPrompt(entry) }] }],
    config: { systemInstruction: RETROSPECTIVE_SYSTEM_PROMPT },
  });

  const text = response.text?.trim();
  if (!text) return;

  chatStore.append({ role: "assistant", content: text, time: Date.now() });
}
