import fs from "node:fs";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  time: number;
}

// Same "runtime state file on disk" pattern as deviceStore.ts -- one shared conversation
// (this app has no user/session concept, see basicAuth.ts), persisted so a restart
// doesn't wipe JUDE's memory of the conversation so far.
const STORE_FILE = process.env.CHAT_HISTORY_FILE ?? ".chat-history.json";

// Bounds both the on-disk file and the context sent to Claude every turn -- unbounded
// history would eventually make every chat call slower and pricier for no benefit, since
// very old turns stop being relevant to "what should JUDE do right now."
const MAX_MESSAGES = 200;

interface OnDisk {
  messages: ChatMessage[];
}

function readFromDisk(): ChatMessage[] {
  try {
    // turbopackIgnore: STORE_FILE is an operator-configured absolute path (often outside
    // the project directory, e.g. a Railway persistent volume) -- not something to trace
    // and bundle the whole project around, same as deviceStore.ts's identical pattern.
    const raw = fs.readFileSync(/* turbopackIgnore: true */ STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as OnDisk;
    return parsed.messages;
  } catch {
    // Missing file (first boot) or corrupt content -- start empty rather than crash the
    // whole server over a runtime-state file, same philosophy as deviceStore.ts.
    return [];
  }
}

class ChatStore {
  private messages: ChatMessage[] | null = null;

  private load(): ChatMessage[] {
    if (!this.messages) this.messages = readFromDisk();
    return this.messages;
  }

  private persist(): void {
    const onDisk: OnDisk = { messages: this.load() };
    fs.writeFileSync(STORE_FILE, JSON.stringify(onDisk, null, 2));
  }

  all(): ChatMessage[] {
    return [...this.load()];
  }

  append(message: ChatMessage): void {
    const messages = this.load();
    messages.push(message);
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    this.persist();
  }

  /** Used by tests to reset the in-memory + on-disk state between cases. */
  clear(): void {
    this.messages = [];
    this.persist();
  }
}

const globalKey = Symbol.for("forex-ai.chatStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: ChatStore };
const g = globalThis as GlobalWithStore;

export const chatStore: ChatStore = g[globalKey] ?? (g[globalKey] = new ChatStore());
