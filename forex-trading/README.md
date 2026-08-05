# Forex Trading

A forex paper-trading dashboard that runs entirely in the browser — no build step, no server, no API keys. Practice trading the major currency pairs with a $10,000 virtual account, live simulated prices, a candlestick chart, and full profit/loss tracking.

![Dark-themed dashboard with a candlestick chart, price tickers, and an order panel](#)

## Features

- **8 major pairs** — EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD, EUR/GBP — with realistic starting prices, pip sizes, and spreads
- **Live simulated market** — prices tick every second using a random-walk engine and aggregate into candles on the chart
- **Candlestick & line chart** — hand-drawn on `<canvas>`, with a crosshair and OHLC tooltip on hover
- **Paper trading** — buy at the ask, sell at the bid, choose your lot size (0.01 to 10 lots), and watch open P/L update in real time
- **Account tracking** — balance, equity, and open P/L, plus a closed-trade history
- **Persistence** — your account and open positions survive page reloads via `localStorage` (with a reset button to start over)

## Getting started

No install needed:

```bash
# from this folder
open index.html        # macOS
xdg-open index.html    # Linux
start index.html       # Windows
```

Or serve it locally:

```bash
npx serve .
```

## How the simulation works

- Each pair holds a **mid price** that takes a small random step every second (JPY pairs use a 0.01 pip size, the rest 0.0001).
- The **bid/ask** are the mid ∓ half the pair's spread. Buys open at the ask and close at the bid; sells do the opposite — so the spread is a real cost, just like a live broker.
- P/L is computed in the quote currency and converted to USD using the simulated cross rates, so USD/JPY and EUR/GBP profits are as honest as EUR/USD ones.
- Ticks aggregate into 5-second candles so the chart moves visibly while you watch.

## Project structure

```
forex-trading/
├── index.html      # page layout
├── css/styles.css  # dark theme styling
└── js/
    ├── market.js   # simulated price engine (pairs, ticks, candles, cross rates)
    ├── chart.js    # canvas candlestick/line chart with crosshair tooltip
    └── app.js      # trading logic, account state, UI wiring, persistence
```

## Roadmap ideas

- Swap the simulator for real quotes (e.g. a free tier of [Twelve Data](https://twelvedata.com/) or [exchangerate.host](https://exchangerate.host/))
- Stop-loss / take-profit orders
- Multiple timeframes (1m / 5m / 1h candles)
- Leverage and margin requirements
- Trade journal export (CSV)

## Disclaimer

This is a practice/learning tool with simulated prices. It is not financial advice and does not place real trades.
