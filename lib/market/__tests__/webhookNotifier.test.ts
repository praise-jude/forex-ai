import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationPayload } from "../pushNotifier";

const loadExecutionConfig = vi.fn();

vi.mock("../executionConfig", () => ({
  loadExecutionConfig: (...args: unknown[]) => loadExecutionConfig(...(args as [])),
}));

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return { category: "risk_alert", title: "JUDE AI — Test", body: "body text", ...overrides };
}

describe("webhookNotifier", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  describe("forwardToAllConfiguredWebhooks", () => {
    it("is a no-op when neither account has a webhook URL configured", async () => {
      loadExecutionConfig.mockReturnValue({ alertWebhookUrl: undefined });
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await forwardToAllConfiguredWebhooks(payload());

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts to the live account's configured URL", async () => {
      loadExecutionConfig.mockImplementation((account: string) => ({
        alertWebhookUrl: account === "live" ? "https://example.com/live-hook" : undefined,
      }));
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await forwardToAllConfiguredWebhooks(payload({ title: "Hello", body: "World" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://example.com/live-hook");
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ text: "Hello\nWorld", content: "Hello\nWorld", category: "risk_alert" });
    });

    it("posts to both accounts' URLs when they differ", async () => {
      loadExecutionConfig.mockImplementation((account: string) => ({
        alertWebhookUrl: account === "live" ? "https://example.com/live-hook" : "https://example.com/demo-hook",
      }));
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await forwardToAllConfiguredWebhooks(payload());

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchMock.mock.calls.map(([url]) => url).sort();
      expect(urls).toEqual(["https://example.com/demo-hook", "https://example.com/live-hook"]);
    });

    it("dedupes when live and demo share the same URL -- never double-posts", async () => {
      loadExecutionConfig.mockReturnValue({ alertWebhookUrl: "https://example.com/shared-hook" });
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await forwardToAllConfiguredWebhooks(payload());

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never throws when the webhook POST fails", async () => {
      loadExecutionConfig.mockReturnValue({ alertWebhookUrl: "https://example.com/hook" });
      fetchMock.mockRejectedValue(new Error("network down"));
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await expect(forwardToAllConfiguredWebhooks(payload())).resolves.toBeUndefined();
    });

    it("never throws on a non-ok HTTP response", async () => {
      loadExecutionConfig.mockReturnValue({ alertWebhookUrl: "https://example.com/hook" });
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await expect(forwardToAllConfiguredWebhooks(payload())).resolves.toBeUndefined();
    });

    it("omits the body-text second line when there's no body", async () => {
      loadExecutionConfig.mockReturnValue({ alertWebhookUrl: "https://example.com/hook" });
      const { forwardToAllConfiguredWebhooks } = await import("../webhookNotifier");

      await forwardToAllConfiguredWebhooks({ category: "risk_alert", title: "Title only", body: "" });

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).text).toBe("Title only");
    });
  });

  describe("sendWebhookNotification", () => {
    it("posts only to the given account's configured URL", async () => {
      loadExecutionConfig.mockImplementation((account: string) => ({
        alertWebhookUrl: account === "demo" ? "https://example.com/demo-hook" : undefined,
      }));
      const { sendWebhookNotification } = await import("../webhookNotifier");

      await sendWebhookNotification(payload(), "demo");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/demo-hook");
    });

    it("is a no-op when that specific account has no URL configured", async () => {
      loadExecutionConfig.mockReturnValue({ alertWebhookUrl: undefined });
      const { sendWebhookNotification } = await import("../webhookNotifier");

      await sendWebhookNotification(payload(), "live");

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
