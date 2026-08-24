// Tracks failed dashboard Basic Auth attempts per IP so proxy.ts can alert on a likely
// brute-force burst. Deliberately alerts rather than blocks -- a hard lockout on this
// single shared-password gate risks locking out the operator themselves (a mistyped
// password, a flaky mobile connection reusing a carrier IP with unrelated bad actors),
// which for a solo real-money app is worse than letting a slow guesser keep guessing
// while the operator gets paged. In-memory (not DB-backed) is intentional: this is a
// live signal, not an audit record, and resets harmlessly on redeploy -- same posture as
// engineMode.ts/connectionWatchdog.ts's own globalThis-singleton state.
const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 5;
// Once a burst has been reported for an IP, don't re-report every subsequent failed
// attempt from it -- one notification per burst is enough signal without being spam.
const NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

interface IpState {
  failures: number[]; // timestamps, ms
  lastNotifiedAt: number;
}

const globalKey = Symbol.for("forex-ai.authAttempts");
type GlobalWithState = typeof globalThis & { [globalKey]?: Map<string, IpState> };
const g = globalThis as GlobalWithState;
const attempts = g[globalKey] ?? (g[globalKey] = new Map());

/**
 * Call on every failed dashboard Basic Auth check. Returns true the moment a given IP
 * crosses THRESHOLD failures within WINDOW_MS, and at most once per NOTIFY_COOLDOWN_MS
 * after that -- the caller (proxy.ts) uses this to decide whether to fire a push
 * notification for this particular failed request.
 */
export function recordFailedDashboardAuth(ip: string): boolean {
  const now = Date.now();
  const state: IpState = attempts.get(ip) ?? { failures: [], lastNotifiedAt: 0 };
  state.failures = state.failures.filter((t) => now - t < WINDOW_MS);
  state.failures.push(now);
  attempts.set(ip, state);

  if (state.failures.length < THRESHOLD) return false;
  if (now - state.lastNotifiedAt < NOTIFY_COOLDOWN_MS) return false;

  state.lastNotifiedAt = now;
  return true;
}

/** Only used by tests -- resets module-level state between cases. */
export function resetAuthAttemptsForTests(): void {
  attempts.clear();
}
