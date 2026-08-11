import { describe, expect, it } from "vitest";
import {
  buildConfirmPhrase,
  buildCooldownAnnouncement,
  buildDailyLossAnnouncement,
  buildResultAnnouncement,
  buildSignalAnnouncement,
  parseVoiceCommand,
} from "../grammar";
import { buildSignal } from "../../market/__tests__/fixtures";

describe("buildConfirmPhrase", () => {
  it("builds a BUY phrase for a long signal, stripping the pair's slash", () => {
    expect(buildConfirmPhrase(buildSignal({ pair: "BTC/USD", direction: "long" }))).toBe("CONFIRM BUY BTCUSD");
  });

  it("builds a SELL phrase for a short signal", () => {
    expect(buildConfirmPhrase(buildSignal({ pair: "EUR/USD", direction: "short" }))).toBe("CONFIRM SELL EURUSD");
  });
});

describe("buildSignalAnnouncement", () => {
  it("mentions direction, pair, and every trade plan figure", () => {
    const text = buildSignalAnnouncement(buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103 }), 1);
    expect(text).toContain("buy opportunity");
    expect(text).toContain("Euro against the US Dollar");
    expect(text).toContain("risk is 1 percent");
    expect(text).toContain("Would you like me to place this trade?");
  });
});

describe("buildResultAnnouncement", () => {
  const signal = buildSignal({ pair: "BTC/USD", direction: "long" });

  it("only claims success on a filled result", () => {
    const text = buildResultAnnouncement(signal, {
      status: "filled",
      trade: {
        id: "t1",
        signalId: signal.id,
        account: "live",
        pair: "BTC/USD",
        direction: "long",
        requestedLots: 0.1,
        requestedEntry: 50000,
        filledEntry: 50010,
        stopLoss: 49500,
        takeProfit: 51000,
        status: "filled",
        riskPct: 1,
        attemptedAt: Date.now(),
      },
    });
    expect(text).toContain("placed successfully");
    expect(text).toContain("50010");
  });

  it("speaks the real reject reason verbatim, never a generic success line", () => {
    const text = buildResultAnnouncement(signal, {
      status: "rejected",
      trade: {
        id: "t1",
        signalId: signal.id,
        account: "live",
        pair: "BTC/USD",
        direction: "long",
        requestedLots: 0.1,
        requestedEntry: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        status: "rejected",
        rejectReason: "not enough free margin",
        riskPct: 1,
        attemptedAt: Date.now(),
      },
    });
    expect(text).not.toContain("placed successfully");
    expect(text).toContain("not enough free margin");
  });

  it("gives the spec's stale-price phrasing for a stale_price block", () => {
    const text = buildResultAnnouncement(signal, { status: "blocked", code: "stale_price", reason: "irrelevant raw reason" });
    expect(text).toContain("market has moved");
    expect(text).toContain("review the updated setup");
  });
});

describe("buildCooldownAnnouncement / buildDailyLossAnnouncement", () => {
  it("states the concrete threshold and cooldown length", () => {
    expect(buildCooldownAnnouncement(3, 30)).toContain("3 losses in a row");
    expect(buildCooldownAnnouncement(3, 30)).toContain("30 minutes");
  });

  it("states the concrete daily loss percentage", () => {
    expect(buildDailyLossAnnouncement(5)).toContain("5 percent");
  });
});

describe("parseVoiceCommand", () => {
  const expected = "CONFIRM BUY BTCUSD";

  it("only hard-confirms on an exact match against the expected phrase", () => {
    expect(parseVoiceCommand("confirm buy btcusd", expected)).toEqual({ kind: "hard_confirm" });
    expect(parseVoiceCommand("Confirm, Buy BTCUSD!", expected)).toEqual({ kind: "hard_confirm" });
  });

  it("never hard-confirms when no phrase is expected, even if the words match", () => {
    expect(parseVoiceCommand("confirm buy btcusd", null)).not.toEqual({ kind: "hard_confirm" });
  });

  it("treats a bare 'confirm' as a soft confirm, not a hard confirm", () => {
    expect(parseVoiceCommand("yes, confirm", expected)).toEqual({ kind: "soft_confirm" });
    expect(parseVoiceCommand("maybe buy btc", expected).kind).not.toBe("hard_confirm");
  });

  it("recognizes decline phrases", () => {
    expect(parseVoiceCommand("cancel", expected)).toEqual({ kind: "decline" });
    expect(parseVoiceCommand("don't place it", expected)).toEqual({ kind: "decline" });
  });

  it("matches phrases on word boundaries, not raw substrings -- 'know'/'eyeshadow'/'snowball' must not misfire on 'no'/'yes'", () => {
    expect(parseVoiceCommand("I know the risk, go ahead", expected).kind).not.toBe("decline");
    expect(parseVoiceCommand("eyeshadow looks nice", expected).kind).not.toBe("soft_confirm");
    expect(parseVoiceCommand("snowball effect", expected).kind).not.toBe("decline");
    // The real words must still match on their own.
    expect(parseVoiceCommand("no", expected)).toEqual({ kind: "decline" });
    expect(parseVoiceCommand("yes", expected)).toEqual({ kind: "soft_confirm" });
  });

  it("recognizes the emergency stop phrases ahead of decline/soft matches", () => {
    expect(parseVoiceCommand("emergency stop", expected)).toEqual({ kind: "emergency_stop" });
    expect(parseVoiceCommand("please stop trading now", expected)).toEqual({ kind: "emergency_stop" });
  });

  it("recognizes read-only queries", () => {
    expect(parseVoiceCommand("what's my current profit", expected)).toEqual({ kind: "query_profit" });
    expect(parseVoiceCommand("show my open trades", expected)).toEqual({ kind: "query_positions" });
    expect(parseVoiceCommand("is autopilot active", expected)).toEqual({ kind: "query_autopilot_status" });
  });

  it("falls back to unrecognized for ambiguous or unrelated speech", () => {
    expect(parseVoiceCommand("maybe buy BTC", expected)).toEqual({ kind: "unrecognized" });
    expect(parseVoiceCommand("", expected)).toEqual({ kind: "unrecognized" });
  });
});
