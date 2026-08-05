import type { Pair, Price } from "./types";

class PriceStore {
  private latest = new Map<Pair, Price>();

  set(price: Price): void {
    this.latest.set(price.pair, price);
  }

  get(pair: Pair): Price | undefined {
    return this.latest.get(pair);
  }

  all(): Price[] {
    return Array.from(this.latest.values());
  }
}

const globalKey = Symbol.for("forex-ai.priceStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: PriceStore };
const g = globalThis as GlobalWithStore;

export const priceStore: PriceStore = g[globalKey] ?? (g[globalKey] = new PriceStore());
