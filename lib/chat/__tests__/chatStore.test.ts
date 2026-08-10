import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatStoreModule } from "./chatStoreTestHelper";
import { loadChatStoreModule } from "./chatStoreTestHelper";

describe("chatStore", () => {
  let storeFile: string;
  let mod: ChatStoreModule;

  beforeEach(async () => {
    storeFile = path.join(os.tmpdir(), `forex-ai-chat-store-${Date.now()}-${Math.random()}.json`);
    mod = await loadChatStoreModule(storeFile);
  });

  afterEach(() => {
    fs.rmSync(storeFile, { force: true });
  });

  it("starts empty when the store file doesn't exist yet", () => {
    expect(mod.chatStore.all()).toEqual([]);
  });

  it("appends messages in order", () => {
    mod.chatStore.append({ role: "user", content: "hi", time: 1 });
    mod.chatStore.append({ role: "assistant", content: "hello", time: 2 });
    expect(mod.chatStore.all()).toEqual([
      { role: "user", content: "hi", time: 1 },
      { role: "assistant", content: "hello", time: 2 },
    ]);
  });

  it("persists across a fresh module load (survives a restart)", async () => {
    mod.chatStore.append({ role: "user", content: "remember this", time: 1 });

    const reloaded = await loadChatStoreModule(storeFile);
    expect(reloaded.chatStore.all()).toEqual([{ role: "user", content: "remember this", time: 1 }]);
  });

  it("bounds history to the most recent 200 messages", () => {
    for (let i = 0; i < 205; i++) {
      mod.chatStore.append({ role: "user", content: `msg-${i}`, time: i });
    }
    const all = mod.chatStore.all();
    expect(all).toHaveLength(200);
    expect(all[0].content).toBe("msg-5");
    expect(all[all.length - 1].content).toBe("msg-204");
  });

  it("clear() empties both memory and disk", () => {
    mod.chatStore.append({ role: "user", content: "hi", time: 1 });
    mod.chatStore.clear();
    expect(mod.chatStore.all()).toEqual([]);
  });
});
