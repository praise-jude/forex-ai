import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTools, type ToolContext } from "../tools";
import { signalStore } from "../../market/signalStore";
import { resetEngineModeForTests } from "../../market/engineMode";
import { buildSignal } from "../../market/__tests__/fixtures";
import { buildSignalAnnouncement } from "../../voice/grammar";

// Loosely typed on purpose: buildTools() returns a heterogeneous array of tools each
// with their own input schema, and these tests deliberately call `run()` directly
// (bypassing the SDK's own schema validation) to exercise the confirm-phrase gate in
// isolation -- the real per-tool input types are already enforced by tools.ts itself.
type TestableTool = { run: (input: Record<string, unknown>) => Promise<unknown> };

function findTool(tools: ReturnType<typeof buildTools>, name: string): TestableTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool as unknown as TestableTool;
}

function ctxWith(rawUserMessage: string): ToolContext {
  return { rawUserMessage, origin: "http://localhost:3000", authHeader: "Basic dGVzdDpwYXNz" };
}

describe("chat tools -- confirm-phrase safety gates", () => {
  beforeEach(() => {
    resetEngineModeForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("execute_trade", () => {
    it("refuses to place the trade when the raw message does not contain the exact confirm phrase", async () => {
      const signal = buildSignal({ id: "safety-test-1", pair: "EUR/USD", direction: "long" });
      signalStore.add(signal);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("yes place it"));
      const execute_trade = findTool(tools, "execute_trade");
      const raw = await execute_trade.run({ signalId: signal.id });
      const result = JSON.parse(raw as string);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("confirmation_required");
      expect(result.message).toContain("CONFIRM BUY EURUSD");
      // Must never reach the broker/execute route without the exact phrase.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses a near-miss phrase (extra/missing words), not just a blank one", async () => {
      const signal = buildSignal({ id: "safety-test-2", pair: "GBP/USD", direction: "short" });
      signalStore.add(signal);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("CONFIRM SELL GBPUSD PLEASE"));
      const execute_trade = findTool(tools, "execute_trade");
      const raw = await execute_trade.run({ signalId: signal.id });
      const result = JSON.parse(raw as string);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("confirmation_required");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("proceeds to call the real execute route only once the exact confirm phrase is present", async () => {
      const signal = buildSignal({ id: "safety-test-3", pair: "EUR/USD", direction: "long" });
      signalStore.add(signal);
      const fetchSpy = vi.fn().mockResolvedValue({
        json: async () => ({ status: "duplicate" }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("confirm buy eurusd"));
      const execute_trade = findTool(tools, "execute_trade");
      await execute_trade.run({ signalId: signal.id });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`http://localhost:3000/api/signals/${signal.id}/execute`);
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Basic dGVzdDpwYXNz" });
    });

    it("never fabricates a fill -- an unknown signal id is refused before any network call", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("CONFIRM BUY EURUSD"));
      const execute_trade = findTool(tools, "execute_trade");
      const raw = await execute_trade.run({ signalId: "does-not-exist" });
      const result = JSON.parse(raw as string);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("not_found");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("set_engine_mode", () => {
    it("refuses to enable live mode without the exact 'ENABLE LIVE TRADING' phrase", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("please turn on live trading"));
      const set_engine_mode = findTool(tools, "set_engine_mode");
      const raw = await set_engine_mode.run({ mode: "live" });
      const result = JSON.parse(raw as string);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("confirmation_required");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("proceeds to call the real engine-mode route once the exact phrase is present", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ mode: "live" }) });
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("ENABLE LIVE TRADING"));
      const set_engine_mode = findTool(tools, "set_engine_mode");
      await set_engine_mode.run({ mode: "live" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/engine-mode");
      expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ mode: "live" });
    });

    it("does not require any confirm phrase for the safe directions (analysis/demo)", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ mode: "analysis" }) });
      vi.stubGlobal("fetch", fetchSpy);

      const tools = buildTools(ctxWith("switch to analysis mode"));
      const set_engine_mode = findTool(tools, "set_engine_mode");
      await set_engine_mode.run({ mode: "analysis" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // Proves there's exactly one computation behind what chat, voice, and the dashboard
  // each show for the same signal -- not three independently-derived readings that
  // could quietly drift apart. get_signals and buildSignalAnnouncement both read
  // straight off the same stored Signal object; this asserts they agree.
  describe("get_signals -- single source of truth with voice", () => {
    it("exposes the same adx/rsi/direction/confidence/Signer B fields the Signal itself carries, and voice speaks the identical confidence number", async () => {
      const signal = buildSignal({
        id: "consistency-test-1",
        pair: "EUR/USD",
        direction: "long",
        confidence: 91,
        adx: 27.4,
        rsi: 58.3,
        signerBDirection: "long",
        signerBConfidence: 88,
      });
      signalStore.add(signal);

      const tools = buildTools(ctxWith("just checking"));
      const get_signals = findTool(tools, "get_signals");
      const raw = await get_signals.run({});
      const entries = JSON.parse(raw as string) as Array<Record<string, unknown>>;
      const entry = entries.find((s) => s.id === signal.id);

      expect(entry).toMatchObject({
        direction: signal.direction,
        confidence: signal.confidence,
        adx: signal.adx,
        rsi: signal.rsi,
        signerBDirection: signal.signerBDirection,
        signerBConfidence: signal.signerBConfidence,
      });

      const spoken = buildSignalAnnouncement(signal, 1);
      expect(spoken).toContain(`${Math.round(signal.confidence)} percent`);
    });
  });
});
