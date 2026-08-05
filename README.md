This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Forex AI signal dashboard

`/dashboard` is a live SMC/ICT-style trading system for MT5 majors (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD). It detects setups (liquidity sweep → structure break → retest of an unmitigated order block/fair value gap, during a London/NY killzone) and shows entry/SL/TP suggestions on the dashboard — **and it trades them automatically**, with no manual approval step. See "Automatic execution" below before pointing this at a real account; the dashboard-only signal detection is unaffected by, and independent of, whether execution is running.

### MetaApi setup

Market data comes from your MT5 account via [MetaApi.cloud](https://metaapi.cloud) — MT5 has no public API of its own, so MetaApi hosts the connection to your terminal for you. Your broker login/password are entered on MetaApi's side, never in this codebase:

1. Sign up at [metaapi.cloud](https://metaapi.cloud) and create an API token (Dashboard → API tokens).
2. Add a trading account (Dashboard → Add account) using your MT5 login, password, and broker server — a demo account works fine for testing.
3. Once the account shows as deployed and connected to the broker, copy its account ID.
4. Copy `.env.local.example` to `.env.local` and fill in `METAAPI_TOKEN` and `METAAPI_ACCOUNT_ID`. If your broker suffixes symbol names (e.g. `EURUSD.a`), also set `MT5_SYMBOL_SUFFIX`.

Without these two env vars, the dashboard still runs but the watchlist stays empty (check the server log for `[market] failed to start market engine`).

### Automatic execution

**Every signal the engine produces is traded automatically** the moment MetaApi is connected — there is no signal-only mode toggle. Position size is computed to risk a fixed % of account equity per trade (never more — sizes are rounded *down* to the broker's lot step, and a trade is skipped entirely rather than force-sized up to the broker minimum if that would exceed the configured risk). Read this whole section before setting `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` on anything but a demo account.

**Config** (`.env.local`, all optional with the defaults below — these are risk-tolerance numbers you should set deliberately, not engineering defaults to trust blindly):

| Var | Default | Meaning |
| --- | --- | --- |
| `RISK_PER_TRADE_PCT` | `1` | % of equity risked per trade |
| `MAX_CONCURRENT_POSITIONS` | `3` | New entries blocked once this many positions are open |
| `MAX_DAILY_LOSS_PCT` | `5` | New entries halted for the rest of the UTC day once realized+open loss reaches this % of start-of-day equity. Existing positions are left alone — this only blocks new entries. |
| `MAX_TRADES_PER_DAY` | `5` | New entries blocked once this many trades have opened today (UTC day) |
| `KILL_SWITCH_FILE` | `.trading-paused` | See below |

**Kill switch**: create the file named by `KILL_SWITCH_FILE` (e.g. `touch .trading-paused` in the project root) to immediately stop new trade entries — checked fresh on every signal, no restart needed. Existing open positions are untouched; delete the file to resume. This is intentionally simple (no auth) to match the rest of the app.

**What's not covered**: pending/limit orders (market orders only, fired at signal time), trailing stops or partial take-profit (SL/TP are set once at open and never adjusted), and portfolio-level correlation limits (nothing stops correlated pairs from both firing and stacking risk beyond `MAX_CONCURRENT_POSITIONS`). The execution ledger (which signal caused which trade) is in-memory only — a restart loses that audit trail, though open positions themselves are safe and are read directly from the broker, not from local memory.

**Before going live**: test against a MetaApi **demo account** first. Confirm a signal produces a correctly-sized order with SL/TP attached, confirm the kill-switch file actually blocks the next signal, and confirm `MAX_DAILY_LOSS_PCT` trips as expected before trusting this with real funds.

### Deployment: not Vercel

The dashboard keeps one persistent MetaApi streaming connection and an in-memory candle/signal store per server process (started once from `instrumentation.ts` on boot). That needs a single **always-on Node process** — `next build && next start` on a VPS, Docker container, or a "web service" host (Railway, Render, Fly, etc.) — not Vercel serverless functions, which are ephemeral per-request and would never keep the connection alive. Run a single instance only: multiple replicas would each open a duplicate MetaApi connection against the same account.

### Tests

The SMC detectors, the signal engine, and the position sizing/risk-limit logic are unit tested with fixtures — no live MetaApi connection needed. (The execution engine's broker-facing orchestration itself isn't unit tested, same as `metaApiConnection.ts` — both are verified against a demo account instead, per "Automatic execution" above.)

```bash
npm run test
```

### Not built yet

Auth, subscriptions, Telegram/push/webhook notifications, a backtesting engine, a mobile app, a positions panel in the dashboard UI, and database persistence (both signals and the execution ledger live only in memory and reset when the server restarts) are intentionally out of scope for this pass.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
