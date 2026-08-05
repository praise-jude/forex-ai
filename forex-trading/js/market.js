/**
 * Simulated forex market: pairs, random-walk ticks, bid/ask spreads,
 * candle aggregation, and USD conversion for P/L.
 */
(function () {
  "use strict";

  const PAIRS = [
    { symbol: "EUR/USD", price: 1.0850, pip: 0.0001, spreadPips: 1.0, decimals: 5 },
    { symbol: "GBP/USD", price: 1.2700, pip: 0.0001, spreadPips: 1.3, decimals: 5 },
    { symbol: "USD/JPY", price: 148.50, pip: 0.01,   spreadPips: 1.1, decimals: 3 },
    { symbol: "AUD/USD", price: 0.6550, pip: 0.0001, spreadPips: 1.2, decimals: 5 },
    { symbol: "USD/CAD", price: 1.3600, pip: 0.0001, spreadPips: 1.4, decimals: 5 },
    { symbol: "USD/CHF", price: 0.8800, pip: 0.0001, spreadPips: 1.4, decimals: 5 },
    { symbol: "NZD/USD", price: 0.6050, pip: 0.0001, spreadPips: 1.6, decimals: 5 },
    { symbol: "EUR/GBP", price: 0.8550, pip: 0.0001, spreadPips: 1.5, decimals: 5 },
  ];

  const TICK_MS = 1000;        // one price step per second
  const CANDLE_TICKS = 5;      // ticks per candle (5-second candles)
  const MAX_CANDLES = 150;

  // Approximate standard normal via sum of uniforms.
  function gaussian() {
    let s = 0;
    for (let i = 0; i < 6; i++) s += Math.random();
    return (s - 3) / 1.5;
  }

  class Market {
    constructor() {
      this.pairs = new Map();
      this.listeners = [];
      this.tickCount = 0;

      for (const cfg of PAIRS) {
        this.pairs.set(cfg.symbol, {
          ...cfg,
          mid: cfg.price,
          prevMid: cfg.price,
          candles: [],
          current: null, // candle being built
        });
      }
      // Seed some history so the chart isn't empty on load.
      for (let i = 0; i < MAX_CANDLES * CANDLE_TICKS; i++) this.step(true);
    }

    onTick(fn) { this.listeners.push(fn); }

    start() {
      this.timer = setInterval(() => {
        this.step(false);
        for (const fn of this.listeners) fn();
      }, TICK_MS);
    }

    step(seeding) {
      this.tickCount++;
      const closeCandle = this.tickCount % CANDLE_TICKS === 0;

      for (const pair of this.pairs.values()) {
        pair.prevMid = pair.mid;
        // Random walk: a couple of pips of volatility per tick, with a tiny
        // pull back toward the seed price so rates stay in a realistic range.
        const drift = (pair.price - pair.mid) * 0.0005;
        const stepSize = pair.pip * 1.5 * gaussian();
        pair.mid = Math.max(pair.pip * 100, pair.mid + stepSize + drift);

        if (!pair.current) {
          pair.current = { o: pair.mid, h: pair.mid, l: pair.mid, c: pair.mid, t: Date.now() };
        }
        const candle = pair.current;
        candle.h = Math.max(candle.h, pair.mid);
        candle.l = Math.min(candle.l, pair.mid);
        candle.c = pair.mid;

        if (closeCandle) {
          pair.candles.push(candle);
          if (pair.candles.length > MAX_CANDLES) pair.candles.shift();
          pair.current = null;
        }
      }
      if (seeding) return;
    }

    get(symbol) { return this.pairs.get(symbol); }

    bid(symbol) {
      const p = this.get(symbol);
      return p.mid - (p.spreadPips * p.pip) / 2;
    }

    ask(symbol) {
      const p = this.get(symbol);
      return p.mid + (p.spreadPips * p.pip) / 2;
    }

    /** Candles including the one still forming. */
    series(symbol) {
      const p = this.get(symbol);
      return p.current ? p.candles.concat(p.current) : p.candles.slice();
    }

    format(symbol, value) {
      return value.toFixed(this.get(symbol).decimals);
    }

    /** Convert 1 unit of `currency` to USD using current mid rates. */
    usdRate(currency) {
      switch (currency) {
        case "USD": return 1;
        case "JPY": return 1 / this.get("USD/JPY").mid;
        case "CAD": return 1 / this.get("USD/CAD").mid;
        case "CHF": return 1 / this.get("USD/CHF").mid;
        case "GBP": return this.get("GBP/USD").mid;
        case "EUR": return this.get("EUR/USD").mid;
        default: return 1;
      }
    }

    quoteCurrency(symbol) { return symbol.split("/")[1]; }
  }

  window.FX = { Market, TICK_MS, CANDLE_TICKS };
})();
