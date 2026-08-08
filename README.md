# forex-ai

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Forex AI signal dashboard

`/dashboard` is a live SMC/ICT-style trading system for MT5 majors (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD). It detects setups (liquidity sweep → structure break → retest of an unmitigated order block/fair value gap, during a London/NY killzone, with D1/H4/H1 trend agreement) and shows entry/SL/TP suggestions on the dashboard as Jude (long) / Omini (short) signal cards, each carrying a weighted confidence score. A score of 90%+ (95%+ for "strong buy") gets a Buy/Sell button; 80-89% is shown as "watch" — informational only, no button, since it didn't clear the bar for a real signal. By default (**ANALYSIS** engine mode) **nothing is sent to the broker automatically** — each executable card has a Buy or Sell button (matching the signal's direction) that a user must click to actually place the trade. Optional **DEMO**/**LIVE** engine modes make confirmed signals auto-execute with no click — see "Engine mode" below. See "Manual execution" below before pointing this at a real account; the dashboard-only signal detection is unaffected by, and independent of, whether a signal ever gets executed.

### MetaApi setup

Market data comes from your MT5 account via [MetaApi.cloud](https://metaapi.cloud) — MT5 has no public API of its own, so MetaApi hosts the connection to your terminal for you. Your broker login/password are entered on MetaApi's side, never in this codebase:

1. Sign up at [metaapi.cloud](https://metaapi.cloud) and create an API token (Dashboard → API tokens).
2. Add a trading account (Dashboard → Add account) using your MT5 login, password, and broker server — a demo account works fine for testing.
3. Once the account shows as deployed and connected to the broker, copy its account ID.
4. Copy `.env.local.example` to `.env.local` and fill in `METAAPI_TOKEN` and `METAAPI_ACCOUNT_ID`. If your broker suffixes symbol names (e.g. `EURUSD.a`), also set `MT5_SYMBOL_SUFFIX`.

Without these two env vars, the dashboard still runs but the watchlist stays empty (check the server log for `[market] failed to start market engine`).

### Manual execution

**Every signal requires a manual Buy/Sell click on its dashboard card** — nothing is traded until a user confirms it. Clicking runs the exact same risk-checked path an automatic engine would: position size is computed to risk a fixed % of account equity per trade (never more — sizes are rounded *down* to the broker's lot step, and a trade is skipped entirely rather than force-sized up to the broker minimum if that would exceed the configured risk). Read this whole section before setting `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` on anything but a demo account.

**Config** (`.env.local`, all optional with the defaults below — these are risk-tolerance numbers you should set deliberately, not engineering defaults to trust blindly):

| Var | Default | Meaning |
| --- | --- | --- |
| `RISK_PER_TRADE_PCT` | `1` | % of equity risked per trade |
| `MAX_CONCURRENT_POSITIONS` | `3` | New entries blocked once this many positions are open |
| `MAX_DAILY_LOSS_PCT` | `5` | New entries halted for the rest of the UTC day once realized+open loss reaches this % of start-of-day equity. Existing positions are left alone — this only blocks new entries. |
| `MAX_TRADES_PER_DAY` | `5` | New entries blocked once this many trades have opened today (UTC day) |
| `KILL_SWITCH_FILE` | `.trading-paused` | See below |
| `TRADING_KILL_SWITCH` | unset | See below |

**Kill switch — two of them, either one blocks trading**:
- **File** (`KILL_SWITCH_FILE`): create the file (e.g. `touch .trading-paused` in the project root) to immediately stop new trade entries — checked fresh on every Buy/Sell click, no restart needed. Delete the file to resume. Works on hosts with a persistent filesystem (a VPS, Docker with a volume). Doesn't help on platforms that rebuild the filesystem on every deploy — a file touched via a one-off shell command won't survive the next redeploy.
- **Env var** (`TRADING_KILL_SWITCH`): set to `1`/`true` in the platform's dashboard (Railway, Render, etc.) to block trading from the very first boot, guaranteed — no shell access or timing race required. `0`/`false`/unset means not active.

Either switch blocks a Buy/Sell click the same way it would have blocked an automatic entry — clicking Buy/Sell while a switch is active returns "Blocked: kill switch is active" on the card instead of placing an order. Existing open positions are untouched by either switch — only new entries are blocked. Both are intentionally simple (no auth) to match the rest of the app.

**Deploying somewhere new (Railway, Render, a fresh VPS, etc.)**: set `TRADING_KILL_SWITCH=1` in that platform's env vars *before* the first deploy that has `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` set, so a stray click during smoke-testing can't place a real order before you've verified the deploy. Only flip it off once you've confirmed the new instance is healthy — and make sure whatever instance you're moving away from is paused too, so you never have two processes trading the same account at once.

**What's not covered**: pending/limit orders (market orders only, fired at the moment Buy/Sell is clicked), trailing stops or partial take-profit (SL/TP are set once at open and never adjusted), and portfolio-level correlation limits (nothing stops correlated pairs from both being manually opened and stacking risk beyond `MAX_CONCURRENT_POSITIONS`). The execution ledger (which signal caused which trade) is in-memory only — a restart loses that audit trail, though open positions themselves are safe and are read directly from the broker, not from local memory.

**Before going live**: test against a MetaApi **demo account** first. Confirm clicking Buy/Sell on a signal produces a correctly-sized order with SL/TP attached, confirm the kill-switch file actually blocks the click, and confirm `MAX_DAILY_LOSS_PCT` trips as expected before trusting this with real funds.

### Engine mode: ANALYSIS / DEMO / LIVE (optional auto-pilot)

The dashboard has a mode selector, next to the connection status and kill switch:

- **ANALYSIS** (default, and the *only* mode on every fresh boot/restart — this is never persisted anywhere): signals are detected and shown, nothing executes automatically. A manual Buy/Sell click still fires against your **live** account, same as always.
- **DEMO**: confirmed SMC signals auto-execute with no click, against a **separate** MetaApi demo account (`METAAPI_DEMO_TOKEN`/`METAAPI_DEMO_ACCOUNT_ID`) — never your live account. While DEMO mode is selected, a manual Buy/Sell click *also* targets the demo account instead of live, so testing can't accidentally place a real order. Requires the demo env vars to be set — otherwise the DEMO button is disabled and switching to it via the API returns 400.
- **LIVE**: confirmed SMC signals auto-execute with no click against your **real** Exness account. This can only be turned on from the dashboard control by typing the exact confirmation phrase shown there (`ENABLE LIVE TRADING`) — re-validated server-side, not just client-side. There is no env var that enables LIVE mode; it is never enabled automatically by the app itself, on boot or otherwise.

DEMO and LIVE go through **exactly the same risk checks** as manual execution — position sizing, max concurrent positions, daily loss limit, max trades/day, and both kill switches — no exceptions. DEMO has its own independent config (`DEMO_RISK_PER_TRADE_PCT`, `DEMO_MAX_CONCURRENT_POSITIONS`, `DEMO_MAX_DAILY_LOSS_PCT`, `DEMO_MAX_TRADES_PER_DAY`, `KILL_SWITCH_FILE_DEMO`) so it can be tuned without touching live's settings; the platform-level `TRADING_KILL_SWITCH` env var is the one exception — it's a single global switch that blocks **both** accounts at once, on purpose, as the "something is wrong, stop everything" escape hatch.

**What auto-pilot does not affect**: the TradingView webhook (above) always targets your live account directly, completely unaffected by engine mode — it has its own dedicated, always-on execution path.

**Before enabling DEMO**: create a free MT5 demo account with your broker (or any broker — MetaApi doesn't require it to match your live broker), add it in your MetaApi dashboard the same way you added the live account, and set `METAAPI_DEMO_TOKEN`/`METAAPI_DEMO_ACCOUNT_ID`. **Before ever typing the LIVE confirmation phrase**: validate the engine's behavior thoroughly in DEMO mode first — LIVE places real orders on real money the instant a signal is confirmed, with no further confirmation per trade.

### TradingView webhook (optional, auto-executes — read this before enabling)

The one exception to "nothing trades automatically": `POST /api/webhooks/tradingview` accepts alerts from a TradingView strategy/indicator and places the order immediately, with **no manual click**. It's disabled by default (the route returns 500 until `TRADINGVIEW_WEBHOOK_SECRET` is set) and, once enabled, still goes through the exact same risk checks and both kill switches described above — no exceptions there. Only enable this for a strategy you've already validated; it bypasses the SMC engine's confidence scoring entirely, since the decision to trade comes from your own TradingView logic instead.

**Setup**:
1. Set `TRADINGVIEW_WEBHOOK_SECRET` in `.env.local` to a long random value. Anyone with the URL *and* this secret can place trades on your account — keep both private, and don't commit the secret.
2. In TradingView, create an alert with the webhook URL set to `https://your-deployment/api/webhooks/tradingview`, and set the alert's **Message** to JSON matching this shape:

```json
{
  "secret": "the same value as TRADINGVIEW_WEBHOOK_SECRET",
  "pair": "{{ticker}}",
  "direction": "{{strategy.order.action}}",
  "entry": "{{close}}",
  "stopLoss": 1.0830,
  "takeProfit": 1.0890,
  "id": "{{timenow}}",
  "timestamp": "{{timenow}}"
}
```

- `pair`: any recognizable ticker — `EURUSD`, `OANDA:XAUUSD`, `FX:GBPUSD` all work (the exchange prefix is stripped). Unrecognized symbols are rejected, never guessed.
- `direction`: `"buy"`/`"long"` or `"sell"`/`"short"`.
- `stopLoss`/`takeProfit`: your strategy's own levels — this app never invents a stop for you here. Must be on the correct side of `entry` for the direction (a long needs `stopLoss < entry < takeProfit`) or the alert is rejected. `takeProfit2` is optional and defaults to `takeProfit`.
- `id`: **required**, and must be stable per genuine alert (use `{{timenow}}`, not a fixed string) — this is what prevents a retried/redelivered alert from opening a second position. Two alerts with the same `id` are treated as the same signal; only the first executes.
- `timestamp`: **required**, TradingView's `{{timenow}}` (UNIX seconds — also accepts milliseconds, auto-detected). The alert is rejected if it's older, or further in the future (clock skew), than `TRADINGVIEW_MAX_ALERT_AGE_SECONDS` (default 60s) — protects against a delayed or queued alert firing on market conditions that no longer hold.

**What it doesn't do**: apply the killzone/session gate (your strategy controls timing, not this app's ICT session logic), or run any SMC confluence checks. It **does** still apply position sizing, `MAX_CONCURRENT_POSITIONS`, `MAX_DAILY_LOSS_PCT`, `MAX_TRADES_PER_DAY`, both kill switches, and now stale-alert rejection, same as everything else.

**Before enabling on a real account**: send a test alert (or `curl`) while a kill switch is active and confirm the response is `{"status":"blocked","code":"kill_switch",...}` — proves the whole pipeline works without ever reaching the broker. Confirm a wrong secret returns 401, a malformed payload (or a `timestamp` outside the max age) returns 400 with a clear reason, before trusting it with a live strategy.

### Deployment: not Vercel

The dashboard keeps one persistent MetaApi streaming connection and an in-memory candle/signal store per server process (started once from `instrumentation.ts` on boot). That needs a single **always-on Node process** — `next build && next start` on a VPS, Docker container, or a "web service" host (Railway, Render, Fly, etc.) — not Vercel serverless functions, which are ephemeral per-request and would never keep the connection alive. Run a single instance only: multiple replicas would each open a duplicate MetaApi connection against the same account.

### Tests

The SMC detectors, the signal engine, and the position sizing/risk-limit logic are unit tested with fixtures — no live MetaApi connection needed. (The execution engine's broker-facing orchestration itself isn't unit tested, same as `metaApiConnection.ts` — both are verified against a demo account instead, per "Manual execution" above.)

```bash
npm run test
```

### Push notifications & JUDE voice (mobile)

The companion mobile app (`forex-ai-mobile`, a separate Expo Router project) talks to this backend over its existing REST API and adds two things this dashboard-only backend doesn't otherwise have: push notifications when the app isn't open, and a voice assistant. Both are optional and off until configured.

**Push notifications** — devices register themselves via `POST /api/devices` (upserted by `deviceId`; prefs via `PATCH /api/devices/[deviceId]`), persisted to a JSON file (`DEVICE_STORE_FILE`, see below) since this app has no database. Sending goes through Expo's push service (`lib/market/pushNotifier.ts`, using `expo-server-sdk`) rather than talking to Firebase/APNs directly — Expo routes to FCM (Android) and APNs (iOS) for you, so this backend never needs Firebase Admin credentials or an Apple push key itself; those are only needed on the mobile app's EAS project (see that repo's setup docs). A notification fires from exactly one place per event type — `signalPublisher.ts` for new buy/sell signals (both the SMC engine and the TradingView webhook funnel through it, so neither can silently skip mobile push), `executionEngine.ts` for trade opened/rejected, `metaApiConnection.ts`'s `onDealAdded` for trade closed (distinguishing stop-loss vs take-profit vs a manual close via the broker deal's own `reason` field) and for the daily-loss/cooldown risk alerts, and `connectionWatcher.ts` (a 30-second poll of `getConnectionStatus`, started from `bootstrap.ts`) for connection lost/restored. Every send is best-effort: a push failure is logged, never thrown, so it can't take down signal detection or trade execution. A device whose token Expo reports as `DeviceNotRegistered` is automatically pruned from the store.

**JUDE voice (speech-to-text)** — `POST /api/voice/transcribe` proxies a recorded voice command to OpenAI's Whisper API using `OPENAI_API_KEY`, so that key never has to live on the phone. Text-to-speech and command parsing both happen entirely on-device in the mobile app (no server involvement) — this route only turns audio into text. A voice command that would place a real trade still goes through the exact same `/api/signals/[id]/execute` route (and therefore the exact same risk checks) as a dashboard Buy/Sell click; the mobile app requires an explicit spoken "CONFIRM" before calling it.

**Config** (`.env.local`, both optional):

| Var | Default | Meaning |
| --- | --- | --- |
| `EXPO_ACCESS_TOKEN` | unset | Only needed if your Expo project requires enhanced-security push tokens; sending works without it otherwise. |
| `DEVICE_STORE_FILE` | `.device-tokens.json` | Where device tokens/prefs persist. Must be on a persistent volume (see "Deployment: not Vercel" below) or every device has to re-register after a redeploy. |
| `OPENAI_API_KEY` | unset | Powers `/api/voice/transcribe`. Without it, that route returns 500; nothing else is affected. |

### Not built yet

Auth, subscriptions, a backtesting engine, and full database persistence (signals and the execution ledger still live only in memory and reset when the server restarts — only device push tokens are file-persisted) are intentionally out of scope for this pass.

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
