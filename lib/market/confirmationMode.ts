export interface ConfirmationModeState {
  /** "confirm" (default): a manual Buy/Sell click opens a Trade Proposal that must be
   * explicitly approved (or is auto-rejected once it expires) before anything reaches
   * MT5 -- see the execute route's own gate. "signal_only": no execute affordance is
   * shown or accepted at all; the AI only ever surfaces signals, never places them.
   * Unlike executionPolicy.ts's "loose end matches today's shipped behavior" reasoning,
   * BOTH values here are safe (neither auto-executes) -- there's no third "skip
   * confirmation" value, since unconditional auto-execution is what DEMO/LIVE engine
   * mode is already for. */
  manualMode: "signal_only" | "confirm";
  /** How long a proposal stays approvable after the signal fired. Long enough to
   * actually read a rich proposal card and decide, short enough that market
   * conditions can't have drifted far -- attemptExecution's own price-drift/spread
   * re-checks catch smaller moves within this window; the TTL exists to catch the
   * "walked away and came back an hour later" case a per-call re-check can't. */
  proposalTtlSeconds: number;
}

const DEFAULT_PROPOSAL_TTL_SECONDS = 120;

function envManualModeDefault(): "signal_only" | "confirm" {
  return process.env.MANUAL_EXECUTION_MODE?.trim().toLowerCase() === "signal_only" ? "signal_only" : "confirm";
}

function envProposalTtlDefault(): number {
  const raw = Number(process.env.PROPOSAL_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROPOSAL_TTL_SECONDS;
}

const globalKey = Symbol.for("forex-ai.confirmationMode");
type GlobalWithState = typeof globalThis & { [globalKey]?: ConfirmationModeState };
const g = globalThis as GlobalWithState;
const state: ConfirmationModeState = g[globalKey] ?? (g[globalKey] = { manualMode: envManualModeDefault(), proposalTtlSeconds: envProposalTtlDefault() });

export function getConfirmationMode(): ConfirmationModeState {
  return state;
}

export function setConfirmationMode(next: Partial<ConfirmationModeState>): ConfirmationModeState {
  if (next.manualMode !== undefined) state.manualMode = next.manualMode;
  if (next.proposalTtlSeconds !== undefined && Number.isFinite(next.proposalTtlSeconds) && next.proposalTtlSeconds > 0) {
    state.proposalTtlSeconds = next.proposalTtlSeconds;
  }
  return state;
}

/** Test-only: returns to the env-var-derived boot default, same convention as
 * engineMode.ts's resetEngineModeForTests / executionPolicy.ts's own reset. */
export function resetConfirmationModeForTests(): void {
  state.manualMode = envManualModeDefault();
  state.proposalTtlSeconds = envProposalTtlDefault();
}

/** Pure. Whether a signal created at `createdAt` is still within its approval window
 * as of `now`. Only meaningful in "confirm" mode -- "signal_only" never has anything
 * to approve in the first place. */
export function isProposalExpired(createdAt: number, now: number, state: ConfirmationModeState): boolean {
  return now - createdAt > state.proposalTtlSeconds * 1000;
}
