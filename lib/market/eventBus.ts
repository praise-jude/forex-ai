import { EventEmitter } from "node:events";
import type { StreamEvent } from "./types";

const EVENT_NAME = "market-event";

class MarketEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: StreamEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }
}

const globalKey = Symbol.for("forex-ai.eventBus");
type GlobalWithBus = typeof globalThis & { [globalKey]?: MarketEventBus };
const g = globalThis as GlobalWithBus;

export const eventBus: MarketEventBus = g[globalKey] ?? (g[globalKey] = new MarketEventBus());
