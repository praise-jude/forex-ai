import { vi } from "vitest";
import type { chatStore as ChatStoreInstance } from "../chatStore";

export interface ChatStoreModule {
  chatStore: typeof ChatStoreInstance;
}

const globalKey = Symbol.for("forex-ai.chatStore");

/** Mirrors deviceStoreTestHelper.ts's loadDeviceStoreModule -- clears the globalThis
 * singleton between loads so a "reload" genuinely re-reads from disk. */
export async function loadChatStoreModule(storeFile: string): Promise<ChatStoreModule> {
  process.env.CHAT_HISTORY_FILE = storeFile;
  delete (globalThis as Record<symbol, unknown>)[globalKey];
  vi.resetModules();
  return import("../chatStore");
}
