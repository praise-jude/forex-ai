# forex-ai

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Forex AI signal dashboard

`/dashboard` is a live SMC/ICT-style trading system for MT5 majors (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD). It detects setups (liquidity sweep → structure break → retest of an unmitigated order block/fair value gap, during a London/NY killzone, with D1/H4/H1 trend agreement) and shows entry/SL/TP suggestions on the dashboard as Jude (long) / Omini (short) signal cards, each carrying a weighted confidence score. A score of 90%+ (95%+ for "strong buy") gets a Buy/Sell button; 80-89% is shown as "watch" — informational only, no button, since it didn't clear the bar for a real signal. By default (**Confirmation Mode**, the default manual-execution behavior — see below) **nothing is sent to the broker automatically, and clicking Buy/Sell doesn't place an order either** — it opens a Trade Proposal that must be explicitly approved (and re-clears every risk check fresh) before anything reaches MT5. Optional **DEMO**/**LIVE** engine modes make confirmed signals auto-execute with no click at all — see "Engine mode" below. See "Confirmation Mode" and "Manual execution" below before pointing this at a real account; the dashboard-only signal detection is unaffected by, and independent of, whether a signal ever gets executed.

### MetaApi setup

Market data comes from your MT5 account via [MetaApi.cloud](https://metaapi.cloud) — MT5 has no public API of its own, so MetaApi hosts the connection to your terminal for you. Your broker login/password are entered on MetaApi's side, never in this codebase:

1. Sign up at [metaapi.cloud](https://metaapi.cloud) and create an API token (Dashboard → API tokens).
2. Add a trading account (Dashboard → Add account) using your MT5 login, password, and broker server — a demo account works fine for testing.
3. Once the account shows as deployed and connected to the broker, copy its account ID.
4. Copy `.env.local.example` to `.env.local` and fill in `METAAPI_TOKEN` and `METAAPI_ACCOUNT_ID`. If your broker suffixes symbol names (e.g. `EURUSD.a`), also set `MT5_SYMBOL_SUFFIX`.

Without these two env vars, the dashboard still runs but the watchlist stays empty (check the server log for `[market] failed to start market engine`).

### Confirmation Mode: the AI proposes, you approve

This is the default, and the entire point of it: **the AI can find and fully prepare a trade, but it can never place one on its own.** A qualifying signal becomes a **Trade Proposal** (`components/dashboard/TradeProposalCard.tsx`) — entry/SL/TP/R:R, D1/H4/H1 bias, score, news/session, and an editable risk % — with a countdown to its approval window (`PROPOSAL_TTL_SECONDS`, default 120s). Only an explicit **Approve & Execute** click sends anything to MT5; **Reject** and **Wait** both do nothing (Reject is logged as a real decision, see the signal funnel below; Wait just closes the card so you can reopen it later). If nothing is decided before the window closes, the proposal reads **EXPIRED** and can no longer be approved — you wait for a fresh setup, never an old one.

This isn't just a UI convention — **the execute route itself (`app/api/signals/[id]/execute/route.ts`) enforces both the expiration and a confirmation-phrase check** (`buildConfirmPhrase`, e.g. `CONFIRM BUY EURUSD` — the same phrase voice and JUDE Chat already required), so no caller (dashboard, voice, chat, or a raw API call) can skip approval; a bare POST with no phrase, or one that's expired, is refused before `attemptExecution` ever runs. Approving re-runs every risk check (price drift, spread, daily loss, cooldown, concurrent positions) fresh at that exact moment — not the moment the signal first fired.

**Signal Only mode** (`MANUAL_EXECUTION_MODE=signal_only`) goes one step further: no execute affordance is shown or accepted at all — the AI only ever surfaces signals. Toggle between modes live from `/dashboard`'s "Auto-execute floor" area, or set the boot default via env var (a redeploy won't silently loosen a deliberate choice either way).

**Unattended auto-execution is a separate, explicitly opt-in thing** — see "Engine mode" below (DEMO/LIVE). Confirmation Mode governs the *manual* Buy/Sell path only.

**Config** (`.env.local`, optional):

| Var | Default | Meaning |
| --- | --- | --- |
| `MANUAL_EXECUTION_MODE` | `confirm` | `confirm` (propose-then-approve) or `signal_only` (no execution path at all) |
| `PROPOSAL_TTL_SECONDS` | `120` | How long a Trade Proposal stays approvable, enforced server-side |

### Manual execution

Approving a Trade Proposal (or, in DEMO/LIVE mode, an auto-fired signal) runs the full risk-checked path: position size is computed to risk a fixed % of account equity per trade (never more — sizes are rounded *down* to the broker's lot step, and a trade is skipped entirely rather than force-sized up to the broker minimum if that would exceed the configured risk). Read this whole section before setting `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` on anything but a demo account.

**Config** (`.env.local`, all optional with the defaults below — these are risk-tolerance numbers you should set deliberately, not engineering defaults to trust blindly; the defaults are intentionally conservative — 0.25% per trade, 1% max daily loss — raise them only once you've validated the strategy, e.g. via "Backtesting" below or your own demo track record):

| Var | Default | Meaning |
| --- | --- | --- |
| `RISK_PER_TRADE_PCT` | `0.25` | % of equity risked per trade (the Trade Proposal card's "Edit Risk" field can override this for one specific trade without changing the account default) |
| `MAX_CONCURRENT_POSITIONS` | `3` | New entries blocked once this many positions are open |
| `MAX_CORRELATED_POSITIONS` | `1` | New entries blocked once this many *correlated* positions are already open (e.g. EUR/USD long + GBP/USD long are both a short-USD bet) — see `lib/market/pairCorrelation.ts` for the (deliberately simple, static) grouping this checks against |
| `MAX_DAILY_LOSS_PCT` | `1` | New entries halted for the rest of the UTC day once realized+open loss reaches this % of start-of-day equity. Existing positions are left alone — this only blocks new entries. Once tripped, DEMO/LIVE auto-execution stays paused even after it clears (day rollover) until you click "Resume trading" on the dashboard — manual approval is unaffected, since a human already reviews every proposal. |
| `MAX_TRADES_PER_DAY` | `5` | New entries blocked once this many trades have opened today (UTC day) |
| `PARTIAL_CLOSE_ENABLED` | `false` | Closes a fraction of a position once price reaches its TP1 and moves the stop to break-even on the remainder. **Off by default** — unlike break-even/trailing, this touches live position volume, not just the stop loss. Exercise on a demo account before enabling on live. |
| `PARTIAL_CLOSE_FRACTION` | `0.5` | Fraction of the position closed at TP1 (only used when `PARTIAL_CLOSE_ENABLED=true`) |
| `CONFIDENCE_SIZING_ENABLED` | `false` | Scales `RISK_PER_TRADE_PCT` by the signal's own final tier (`buy` vs `strong_buy` — SMC's tier, optionally upgraded by Signer B agreement) instead of every executable signal risking the same flat %. **Off by default** — like `PARTIAL_CLOSE_ENABLED`, this changes actual position size. Exercise on a demo account before enabling on live. Never applied to a manual "Edit Risk" override — that's an explicit human decision for one trade, not something a tier multiplier should second-guess. |
| `RISK_MULTIPLIER_BUY` | `1.0` | Multiplier applied to `RISK_PER_TRADE_PCT` for a `buy`-tier signal (only when `CONFIDENCE_SIZING_ENABLED=true`) |
| `RISK_MULTIPLIER_STRONG_BUY` | `1.5` | Multiplier applied to `RISK_PER_TRADE_PCT` for a `strong_buy`-tier signal (only when `CONFIDENCE_SIZING_ENABLED=true`). A non-positive or non-numeric value is ignored and treated as `1.0` (no scaling), never silently amplifying risk from a config typo. |
| `CONFIDENCE_CALIBRATION_MIN_SAMPLES` | `30` | Minimum closed trades a confidence tier (`buy`/`strong_buy`) needs before `/settings`' calibration section reports a real win rate/average R for it, instead of "insufficient data". Read-only measurement — never wired into `CONFIDENCE_SIZING_ENABLED`'s multipliers; see `lib/market/tradeJournal.ts`'s `getConfidenceCalibration`. |
| `M5_CONFIRMATION_ENABLED` | `true` | Requires the most recently closed 5-minute candle to close in a would-be signal's own direction before it fires — an on-demand REST check at decision time (see `lib/market/m5Confirmation.ts`), never a live M5 subscription (that was deliberately removed earlier as the fix for a real MetaApi rate-limit incident). On by default: this can only make execution *more* conservative, never less. |
| `KILL_SWITCH_FILE` | `.trading-paused` | See below |
| `TRADING_KILL_SWITCH` | unset | See below |

**Close All Positions**: a destructive, separately-confirmed action (next to the kill switch on `/dashboard`) that closes every currently open position on whichever account a manual click targets — pairs with the kill switch (which only stops *new* entries) for a genuine "get me out of everything right now" escape hatch.

**Kill switch — two of them, either one blocks trading**:
- **File** (`KILL_SWITCH_FILE`): create the file (e.g. `touch .trading-paused` in the project root) to immediately stop new trade entries — checked fresh on every Buy/Sell click, no restart needed. Delete the file to resume. Works on hosts with a persistent filesystem (a VPS, Docker with a volume). Doesn't help on platforms that rebuild the filesystem on every deploy — a file touched via a one-off shell command won't survive the next redeploy.
- **Env var** (`TRADING_KILL_SWITCH`): set to `1`/`true` in the platform's dashboard (Railway, Render, etc.) to block trading from the very first boot, guaranteed — no shell access or timing race required. `0`/`false`/unset means not active.

Either switch blocks a Buy/Sell click the same way it would have blocked an automatic entry — clicking Buy/Sell while a switch is active returns "Blocked: kill switch is active" on the card instead of placing an order. Existing open positions are untouched by either switch — only new entries are blocked. Both are intentionally simple (no auth) to match the rest of the app.

### Signal engine: two independent signers

Every setup is found by SMC alone (Signer A — liquidity sweeps, structure breaks, order blocks/FVGs; see `lib/market/signalEngine.ts`), then checked against an independent second signer (Signer B — EMA trend, RSI momentum/divergence, Supertrend, currency strength, session; see `lib/market/signerB.ts`) that's computed without reference to SMC's own direction. A trade only proceeds when the two agree; a genuine tie or opposite-direction read from Signer B holds it (`lib/market/decisionMatrix.ts`) — but a merely-weaker, still-agreeing Signer B never drags SMC's own score down. A confidence number is "how well-confirmed is this setup," not a probability of profit — see "Backtesting" below for how to check any of this against real history, and its own honestly-disclosed limitations.

London/New York killzone hours (`lib/market/sessions.ts`) default to 08:00–11:00 London local time and 08:00–12:00 New York local time — **each region's own real local clock**, not a fixed UTC offset, so the window stays correct year-round through both the UK's and US's own (differently-timed) DST transitions instead of silently drifting an hour off for half the year. Optionally overridable per `.env.local`:

| Var | Default | Meaning |
| --- | --- | --- |
| `LONDON_START_HOUR` / `LONDON_END_HOUR` | `8` / `11` | London killzone window, **London local hour** (0-23), DST-aware |
| `NEW_YORK_START_HOUR` / `NEW_YORK_END_HOUR` | `8` / `12` | New York killzone window, **New York local hour** (0-23), DST-aware |

An invalid value (out of 0-23 range, or a start hour not before the end hour) is ignored and the default is used instead.

This deployment's `.env.local` sets `NEW_YORK_END_HOUR=13` (extending the NY window by one hour, `8`→`13` NY local) — tuned for a West Africa/Nigeria (WAT, UTC+1, no DST) trader: London 08:00–11:00 local lines up with 08:00–11:00 WAT, and the extended NY window covers ~13:00–18:00 WAT (the London/NY overlap plus a continuation/reversal hour) during Northern-hemisphere summer (BST/EDT). Because this still tracks real London/NY local time, the WAT-observed window shifts about an hour earlier during Northern winter (GMT/EST) — that's the DST-awareness working correctly, not a bug.

**Deploying somewhere new (Railway, Render, a fresh VPS, etc.)**: set `TRADING_KILL_SWITCH=1` in that platform's env vars *before* the first deploy that has `METAAPI_TOKEN`/`METAAPI_ACCOUNT_ID` set, so a stray click during smoke-testing can't place a real order before you've verified the deploy. Only flip it off once you've confirmed the new instance is healthy — and make sure whatever instance you're moving away from is paused too, so you never have two processes trading the same account at once.

**What's not covered**: pending/limit orders (market orders only, fired at the moment Buy/Sell is clicked). Correlation limits (`MAX_CORRELATED_POSITIONS`) use a deliberately simple, static pair grouping, not a rolling correlation coefficient — see `lib/market/pairCorrelation.ts`. The execution ledger (which signal caused which trade) is in-memory only — a restart loses that audit trail, though open positions themselves are safe and are read directly from the broker, not from local memory.

**Before going live**: test against a MetaApi **demo account** first. Confirm clicking Buy/Sell on a signal produces a correctly-sized order with SL/TP attached, confirm the kill-switch file actually blocks the click, and confirm `MAX_DAILY_LOSS_PCT` trips as expected before trusting this with real funds.

### Engine mode: ANALYSIS / DEMO / LIVE (optional auto-pilot)

The dashboard has a mode selector, next to the connection status and kill switch:

- **ANALYSIS** (default, and the *only* mode on every fresh boot/restart — this is never persisted anywhere): signals are detected and shown, nothing executes automatically. A manual Buy/Sell click still targets your **live** account, same as always — subject to Confirmation Mode above (a Trade Proposal requiring explicit approval by default, or no execute path at all in Signal Only mode).
- **DEMO**: confirmed SMC signals auto-execute with no click, against a **separate** MetaApi demo account (`METAAPI_DEMO_TOKEN`/`METAAPI_DEMO_ACCOUNT_ID`) — never your live account. While DEMO mode is selected, a manual Buy/Sell click *also* targets the demo account instead of live, so testing can't accidentally place a real order. Requires the demo env vars to be set — otherwise the DEMO button is disabled and switching to it via the API returns 400.
- **LIVE**: confirmed SMC signals auto-execute with no click against your **real** Exness account. This can only be turned on from the dashboard control by typing the exact confirmation phrase shown there (`ENABLE LIVE TRADING`) — re-validated server-side, not just client-side. There is no env var that enables LIVE mode; it is never enabled automatically by the app itself, on boot or otherwise.

DEMO and LIVE go through **exactly the same risk checks** as manual execution — position sizing, max concurrent positions, daily loss limit, max trades/day, and both kill switches — no exceptions. DEMO has its own independent config (`DEMO_RISK_PER_TRADE_PCT`, `DEMO_MAX_CONCURRENT_POSITIONS`, `DEMO_MAX_DAILY_LOSS_PCT`, `DEMO_MAX_TRADES_PER_DAY`, `KILL_SWITCH_FILE_DEMO`) so it can be tuned without touching live's settings; the platform-level `TRADING_KILL_SWITCH` env var is the one exception — it's a single global switch that blocks **both** accounts at once, on purpose, as the "something is wrong, stop everything" escape hatch.

**What auto-pilot does not affect**: the TradingView webhook (above) always targets your live account directly, completely unaffected by engine mode — it has its own dedicated, always-on execution path.

**Before enabling DEMO**: create a free MT5 demo account with your broker (or any broker — MetaApi doesn't require it to match your live broker), add it in your MetaApi dashboard the same way you added the live account, and set `METAAPI_DEMO_TOKEN`/`METAAPI_DEMO_ACCOUNT_ID`. **Before ever typing the LIVE confirmation phrase**: validate the engine's behavior thoroughly in DEMO mode first — LIVE places real orders on real money the instant a signal is confirmed, with no further confirmation per trade.

### Multi-timeframe bias & execution policy

Every M15/M30/1H setup the SMC engine finds must already agree with D1, H4, and H1 EMA50/200 trend direction — this is a hard pre-gate in `signalEngine.ts`, not a display-only filter: a bar where all three don't exactly agree with each other and with the setup's own implied direction never even reaches structure/liquidity detection (`trend_disagreement`). The dashboard's per-pair card shows this same D1/H4/H1 read continuously (a small "D1 ▲ · H4 ▲ · H1 ▼" row), not just when a signal happens to get blocked for that specific reason.

On top of that, the **Auto-execute floor** control (next to the engine-mode selector on `/dashboard`) lets you raise *how selective* auto-execution is without a redeploy — require `strong_buy` instead of `buy`, and/or a minimum risk/reward — without changing how signals are scored or how take-profit targets are picked (those stay fixed, tested constants). It can only ever make execution *more* selective than the shipped default (`buy`, no RR minimum), never less, so no confirmation phrase is needed to change it. TradingView-sourced signals are exempt (see `EXEC_MIN_TIER`/`EXEC_MIN_RISK_REWARD` above) — that integration hardcodes tier `buy` by design and has its own dedicated execution path.

### Backtesting

`/backtest` replays the *real* signal engine — same D1/H4/H1 gate, same SMC detectors, same scoring, same Signer B — bar by bar against historical MetaApi candles, for a chosen pair (or all pairs), timeframe, and lookback window (up to 180 days). One run at a time; a running job shows live progress and can be cancelled between pairs.

**Read the disclosure banner on every result before trusting the numbers** — two things are deliberately *not* simulated because no historical archive exists to check against: high-impact news blackout (the live news filter only holds a near-term calendar, so it always reads "clear" for a past date) and currency-strength confirmation (excluded from Signer B's vote entirely rather than silently fed today's real reading into a bar from weeks ago). Position management (break-even, trailing stop, early invalidation exit) also isn't simulated — only a fixed stop-loss vs. take-profit-1 forward scan, with the pessimistic tie-break (stop-loss wins) when a single candle's range crosses both. Sizing uses a fixed hypothetical stake, not real lot sizing/spread/commission/compounding. All of this means results skew more optimistic than live trading — treat this as a filter-quality check (does the multi-timeframe gate actually produce a positive edge over history), not a profit projection.

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

**Push notifications** — devices register themselves via `POST /api/devices` (upserted by `deviceId`; prefs via `PATCH /api/devices/[deviceId]`), persisted to a JSON file (`DEVICE_STORE_FILE`, see below) since this app has no database. Sending goes through Expo's push service (`lib/market/pushNotifier.ts`, using `expo-server-sdk`) rather than talking to Firebase/APNs directly — Expo routes to FCM (Android) and APNs (iOS) for you, so this backend never needs Firebase Admin credentials or an Apple push key itself; those are only needed on the mobile app's EAS project (see that repo's setup docs). A notification fires from exactly one place per event type — `signalPublisher.ts` for new buy/sell signals (both the SMC engine and the TradingView webhook funnel through it, so neither can silently skip mobile push), `executionEngine.ts` for trade opened/rejected, `metaApiConnection.ts`'s `onDealAdded` for trade closed (distinguishing stop-loss vs take-profit vs a manual close via the broker deal's own `reason` field) and for the daily-loss/cooldown risk alerts, `connectionWatcher.ts` (a 30-second poll of `getConnectionStatus`, started from `bootstrap.ts`) for connection lost/restored, and `weeklyDigest.ts` (an hourly check against a persisted last-sent ISO week key, also started from `bootstrap.ts`) for the passive weekly performance summary. Every send is best-effort: a push failure is logged, never thrown, so it can't take down signal detection or trade execution. A device whose token Expo reports as `DeviceNotRegistered` is automatically pruned from the store.

**JUDE voice (speech-to-text)** — `POST /api/voice/transcribe` proxies a recorded voice command to OpenAI's Whisper API using `OPENAI_API_KEY`, so that key never has to live on the phone. Text-to-speech and command parsing both happen entirely on-device in the mobile app (no server involvement) — this route only turns audio into text. A voice command that would place a real trade still goes through the exact same `/api/signals/[id]/execute` route (and therefore the exact same risk checks) as a dashboard Buy/Sell click; the mobile app requires an explicit spoken "CONFIRM" before calling it.

**Config** (`.env.local`, both optional):

| Var | Default | Meaning |
| --- | --- | --- |
| `EXPO_ACCESS_TOKEN` | unset | Only needed if your Expo project requires enhanced-security push tokens; sending works without it otherwise. |
| `DEVICE_STORE_FILE` | `.device-tokens.json` | Where device tokens/prefs persist. Must be on a persistent volume (see "Deployment: not Vercel" below) or every device has to re-register after a redeploy. |
| `WEEKLY_DIGEST_STORE_FILE` | `.weekly-digest-state.json` | Where the weekly digest's last-sent-week marker persists. Same persistent-volume requirement — otherwise a redeploy right at the weekly boundary could resend or skip a digest. |
| `OPENAI_API_KEY` | unset | Powers `/api/voice/transcribe`. Without it, that route returns 500; nothing else is affected. |

### JUDE Chat

`POST /api/chat {message}` / `GET /api/chat` is a single shared conversational assistant (one history, persisted to `CHAT_HISTORY_FILE`, since this app has no per-user concept — see "Not built yet") backed by the Claude API (`lib/chat/engine.ts`, `ANTHROPIC_API_KEY`). It answers questions about current predictions/signals/positions/risk/engine mode via read-only tools (`lib/chat/tools.ts`), and can pause/resume trading, switch engine mode, or execute a specific trade signal via the exact same REST routes (`/api/kill-switch`, `/api/engine-mode`, `/api/signals/[id]/execute`) a manual dashboard click already uses — the chat layer never calls `attemptExecution`/`enableLiveMode`/the kill-switch file writes directly, so those functions are still only ever invoked from their one existing route handler each. Trade execution and enabling LIVE mode are gated exactly like voice: the tool implementation checks the raw, unmodified text of the user's current message against the real confirmation phrase (`buildConfirmPhrase`/`ENABLE LIVE TRADING`) itself, server-side, before making that call — the model's tool-call arguments are never trusted as proof of confirmation.

| Var | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Powers `/api/chat`. Without it, that route returns 502; nothing else is affected. |
| `CHAT_HISTORY_FILE` | `.chat-history.json` | Where the shared conversation persists. Must be on a persistent volume or history resets on redeploy (same caveat as `DEVICE_STORE_FILE`). |

### Customer accounts (Stage 1 of a paid API platform)

`/account` is a genuinely separate, public product surface — real per-user sign-up/sign-in for customers of a future **Forex AI API**, with nothing to do with `/dashboard`'s own operator-only `DASHBOARD_ACCESS_PASSWORD` (see "Dashboard access" above) or the trading engine itself. `proxy.ts` exempts `/account/*` and `/api/account/*` from that Basic Auth gate on purpose — a customer signing up must never need the operator's dashboard password, and vice versa.

This is the first piece of database persistence this app has ever had (`lib/db/`, Postgres via Drizzle — everything else, e.g. signals and the execution ledger, is still in-memory/file-based, see "Not built yet" below). Accounts support email+password (hashed with `bcryptjs`) and "Continue with Google" (`google-auth-library`, OAuth Authorization Code flow), with a DB-backed session table (`lib/account/sessions.ts`) — the raw session token lives only in an `httpOnly`/`secure`/`sameSite=lax` cookie, never a JWT, so a session can be revoked by deleting one row.

- `POST /api/account/signup`, `/signin`, `/signout` — email+password auth. Sign-up auto-signs-in immediately (unverified) and best-effort sends a verification email; a failed send never blocks sign-up.
- `GET /api/account/verify-email?token=...`, `POST /api/account/request-password-reset`, `/reset-password` — link-based flows, both token tables have real expiries (24h / 1h) and single-use semantics.
- `GET /api/account/google/start`, `/google/callback` — redirects to Google, verifies the returned ID token server-side (`OAuth2Client.verifyIdToken`), links by Google's `sub` claim first (falling back to matching an existing email) rather than trusting email alone as identity.
- `/account/signup`, `/account/signin`, `/account/verify-email`, `/account/reset-password`, `/account` — the matching pages; `/account` itself is a placeholder "signed in as" screen today, becomes the real customer portal (API keys, usage, billing) in later stages.

Sign-in returns the same generic error for "no such user," "wrong password," and "Google-only account, no password set" — and the password-reset request endpoint always returns the same generic success message — both deliberately, to avoid leaking which emails have accounts.

**Local dev database**: this app has no other database, so there's no `docker-compose` Postgres to spin up — it points at the same Railway Postgres the deployed app uses, reached locally through Railway's own tunnel (not a public proxy):

```bash
railway connect Postgres --tunnel-only -P 5432
```

Leave that running in its own terminal, then set `DATABASE_URL` in `.env.local` to the same connection string Railway uses but with the host swapped to `localhost:5432`. Migrations are explicit, never boot-triggered (same "nothing auto-enables" philosophy as `TRADING_KILL_SWITCH`):

```bash
npm run db:generate   # after editing lib/db/schema.ts — writes drizzle/*.sql, commit these
npm run db:migrate    # applies pending migrations to DATABASE_URL
```

**Config** (`.env.local`):

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | unset | Postgres connection string. Required for any `/account`/`/api/account` route to work. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` | unset | From a Google Cloud OAuth Client (console.cloud.google.com → APIs & Services → Credentials). Without these, email/password auth still works fine — only "Continue with Google" is affected. |
| `RESEND_API_KEY` / `EMAIL_FROM_ADDRESS` | unset | Sends verification/reset emails via a single Resend `fetch` call. Without these, accounts still work — the email send just fails (logged, never thrown), so verification links have to be pulled from the DB directly. |
| `APP_BASE_URL` | request origin | Base URL used to build absolute links in those emails. |

### Signal/execution/journal history persistence

Fired signals (`lib/market/signalStore.ts`), the execution ledger (`lib/market/positionStore.ts`, "which signal caused which trade, requested vs filled"), and the trade journal (`lib/market/tradeJournal.ts`, closed-trade history + signal-decision outcomes) are opportunistically persisted to the same Postgres `DATABASE_URL` used by "Customer accounts" above (`signals`/`executed_trades`/`journal_entries`/`journal_pending_contexts`/`journal_signal_outcomes` tables, `lib/db/tradingSchema.ts`), so recent history survives a restart. This is a durability/audit backstop, not a new read path or a hard dependency: all three stores keep their own in-memory copy as the real, synchronous source of truth (unchanged from before this existed — `positionStore`'s idempotency guard in particular must stay race-free against a duplicate click, so it's never blocked on a DB round trip), and every DB write/read is best-effort — logged on failure, never thrown. **Without `DATABASE_URL` set, the trading engine behaves exactly as it always has**: fully functional, in-memory-only, history lost on restart (one log line at boot notes this). Uses its own DB accessor (`lib/db/optionalClient.ts`), separate from `lib/db/client.ts`'s `db` — that one is specific to `/account` routes and requires `DATABASE_URL`; this one must not throw just from being imported, since `signalStore.ts`/`positionStore.ts`/`tradeJournal.ts` load on every boot regardless of DB config.

`tradeJournal.ts` used to persist to a local JSON file (`.trade-journal.json`) instead of Postgres — migrated so journal history (and everything built on top of it: confidence calibration, confluence-edge analytics, the equity curve, slippage analytics) survives a Railway redeploy the way a real database does, rather than living on ephemeral disk.

### Not built yet

API tokens, rate limiting, usage tracking, Paystack subscriptions/billing, a public marketing site and docs, and mobile parity for accounts are intentionally out of scope for this pass.

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
