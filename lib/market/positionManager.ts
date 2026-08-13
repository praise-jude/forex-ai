import type { AccountKey, ExecutedTrade } from "./types";
import { loadExecutionConfig } from "./executionConfig";
import { closePositionPartially, getOpenPositions, getSymbolSpecification, isAccountConfigured, modifyPosition } from "./metaApiConnection";
import { roundDownToStep } from "./positionSizing";
import { positionStore } from "./positionStore";

export interface PositionManagementConfig {
  breakEvenTriggerR: number;
  trailingArmTriggerR: number;
  trailingDistanceFractionOfStop: number;
  partialCloseEnabled: boolean;
}

export interface PositionManagementState {
  breakEvenApplied: boolean;
  trailingArmed: boolean;
  partialCloseApplied: boolean;
}

export type PositionManagementAction =
  | { type: "none" }
  | { type: "partial_close" }
  | { type: "break_even"; newStopLoss: number }
  | { type: "arm_trailing"; distance: number };

/**
 * Pure -- R is always computed off the trade's OWN original entry/stop (never a live,
 * possibly-already-moved stop loss), so the threshold math can't drift as the position
 * itself gets managed. Once trailing is armed the broker owns the stop from then on --
 * break-even is never (re-)applied afterward, since doing so could move a broker-ratcheted
 * trailing stop backward to a worse (less protective) level.
 *
 * partial_close is checked first, ahead of even the trailingArmed early-return -- hitting
 * TP1 is a real price level the signal engine picked out, not an R-ratio heuristic, and
 * remains worth locking in regardless of whether trailing already armed on a fast-moving
 * position (the two aren't mutually exclusive: partial-close now, the trailed remainder
 * keeps running). Its own partialCloseApplied flag (not trailingArmed/breakEvenApplied)
 * guards it from ever re-firing once applied.
 */
export function evaluatePositionForManagement(
  trade: ExecutedTrade,
  currentPrice: number,
  config: PositionManagementConfig,
  state: PositionManagementState
): PositionManagementAction {
  const stopDistance = Math.abs(trade.requestedEntry - trade.stopLoss);
  if (stopDistance <= 0) return { type: "none" };

  if (config.partialCloseEnabled && !state.partialCloseApplied) {
    const reachedTp1 = trade.direction === "long" ? currentPrice >= trade.takeProfit : currentPrice <= trade.takeProfit;
    if (reachedTp1) return { type: "partial_close" };
  }

  const favorableMove = trade.direction === "long" ? currentPrice - trade.requestedEntry : trade.requestedEntry - currentPrice;
  const r = favorableMove / stopDistance;

  if (state.trailingArmed) return { type: "none" };

  if (r >= config.trailingArmTriggerR) {
    // Rounded for the same reason positionSizing.ts's own roundDownToStep rounds before
    // comparing -- raw floating point noise shouldn't reach the broker as a distance.
    const distance = Number((config.trailingDistanceFractionOfStop * stopDistance).toFixed(8));
    return { type: "arm_trailing", distance };
  }
  if (!state.breakEvenApplied && r >= config.breakEvenTriggerR) {
    return { type: "break_even", newStopLoss: trade.requestedEntry };
  }
  return { type: "none" };
}

// Comfortably above MetaApi's own documented rate limit (a position's stop loss can be
// modified no more often than once every 15 seconds) -- this is only how often the ARM
// decision is re-checked, not how often the stop itself moves once trailing is armed
// (that part runs server-side, on MetaApi's own infrastructure, independent of this poll).
const POLL_INTERVAL_MS = 30_000;

const globalKey = Symbol.for("forex-ai.positionManager");
interface PositionManagerGlobalState {
  started: boolean;
  positionStates: Map<string, PositionManagementState>;
}
type GlobalWithState = typeof globalThis & { [globalKey]?: PositionManagerGlobalState };
const g = globalThis as GlobalWithState;
const globalState: PositionManagerGlobalState = g[globalKey] ?? (g[globalKey] = { started: false, positionStates: new Map() });

function stateKeyFor(accountKey: AccountKey, brokerPositionId: string): string {
  return `${accountKey}:${brokerPositionId}`;
}

async function runAccountCycle(accountKey: AccountKey): Promise<void> {
  const config = loadExecutionConfig(accountKey);
  if (!config.positionManagementEnabled) return;

  // One read of live broker state per account per cycle -- every trade below is
  // cross-checked against it rather than trusted from positionStore alone, so a
  // position that already closed naturally (SL/TP hit moments earlier) is simply
  // skipped here instead of racing a modify/close call against a dead position id.
  const openById = new Map(getOpenPositions(accountKey).map((p) => [p.id, p]));

  const trades = positionStore.all().filter((t) => t.account === accountKey && t.status === "filled" && t.brokerPositionId);

  for (const trade of trades) {
    const brokerPositionId = trade.brokerPositionId;
    if (!brokerPositionId) continue;
    const live = openById.get(brokerPositionId);
    if (!live) continue; // already closed naturally -- onDealAdded/recordJournalOutcome already handled it

    const stateKey = stateKeyFor(accountKey, brokerPositionId);
    const positionState = globalState.positionStates.get(stateKey) ?? { breakEvenApplied: false, trailingArmed: false, partialCloseApplied: false };

    const managementConfig: PositionManagementConfig = {
      breakEvenTriggerR: config.breakEvenTriggerR,
      trailingArmTriggerR: config.trailingArmTriggerR,
      trailingDistanceFractionOfStop: config.trailingDistanceFractionOfStop,
      partialCloseEnabled: config.partialCloseEnabled,
    };
    const action = evaluatePositionForManagement(trade, live.currentPrice, managementConfig, positionState);
    if (action.type === "none") continue;

    if (action.type === "partial_close") {
      const spec = getSymbolSpecification(trade.pair, accountKey);
      if (!spec) {
        console.error(`[position-manager] partial close skipped for ${trade.pair} (${brokerPositionId}, ${accountKey}): no symbol specification available yet`);
        continue;
      }

      const volume = roundDownToStep(live.lots * config.partialCloseFraction, spec.volumeStep);
      // Below the broker's minimum, or leaves nothing meaningfully "remaining" -- either
      // way this isn't a valid partial close. Mark it applied anyway so this doesn't get
      // re-logged and re-attempted every 30s cycle for the life of the position.
      if (volume < spec.volumeMin || volume >= live.lots) {
        globalState.positionStates.set(stateKey, { ...positionState, partialCloseApplied: true });
        console.log(`[position-manager] skipping partial close for ${trade.pair} (${brokerPositionId}, ${accountKey}): computed volume ${volume} invalid (live lots ${live.lots}, broker min ${spec.volumeMin})`);
        continue;
      }

      const closeResult = await closePositionPartially(brokerPositionId, volume, accountKey);
      if (!closeResult.success) {
        console.error(`[position-manager] partial close failed for ${trade.pair} (${brokerPositionId}, ${accountKey}): ${closeResult.message}`);
        continue;
      }

      // Same break-even move the break_even action below performs -- applied here too
      // (and breakEvenApplied set alongside partialCloseApplied) so that branch never
      // redundantly re-fires next cycle.
      const beResult = await modifyPosition(brokerPositionId, { stopLoss: trade.requestedEntry, takeProfit: live.takeProfit }, accountKey);
      globalState.positionStates.set(stateKey, { ...positionState, partialCloseApplied: true, breakEvenApplied: true });
      console.log(
        `[position-manager] partial-closed ${volume} lots of ${trade.pair} (${brokerPositionId}, ${accountKey}) at TP1${beResult.success ? ", moved remainder to break-even" : ` (break-even move failed: ${beResult.message})`}`
      );
    } else if (action.type === "break_even") {
      const result = await modifyPosition(brokerPositionId, { stopLoss: action.newStopLoss, takeProfit: live.takeProfit }, accountKey);
      if (result.success) {
        globalState.positionStates.set(stateKey, { ...positionState, breakEvenApplied: true });
        console.log(`[position-manager] moved ${trade.pair} (${brokerPositionId}, ${accountKey}) to break-even @ ${action.newStopLoss}`);
      } else {
        console.error(`[position-manager] break-even move failed for ${trade.pair} (${brokerPositionId}, ${accountKey}): ${result.message}`);
      }
    } else {
      // Explicitly re-pass the position's own current live stop loss rather than relying
      // on ambiguous omitted-field behavior at the SDK/broker boundary -- see
      // modifyPosition's own doc comment.
      const result = await modifyPosition(
        brokerPositionId,
        { stopLoss: live.stopLoss, takeProfit: live.takeProfit, trailingStopLoss: { distance: { distance: action.distance, units: "RELATIVE_PRICE" } } },
        accountKey
      );
      if (result.success) {
        // Arming trailing supersedes break-even -- the broker now keeps the stop no
        // worse than this level going forward, so break-even is marked applied too
        // (never separately re-applied, which could move the stop backward).
        globalState.positionStates.set(stateKey, { ...positionState, breakEvenApplied: true, trailingArmed: true });
        console.log(`[position-manager] armed trailing stop for ${trade.pair} (${brokerPositionId}, ${accountKey}), distance ${action.distance}`);
      } else {
        console.error(`[position-manager] arm trailing failed for ${trade.pair} (${brokerPositionId}, ${accountKey}): ${result.message}`);
      }
    }
  }
}

async function runPollCycle(): Promise<void> {
  const accounts: AccountKey[] = ["live", ...(isAccountConfigured("demo") ? (["demo"] as const) : [])];
  for (const accountKey of accounts) {
    try {
      await runAccountCycle(accountKey);
    } catch (error) {
      console.error(`[position-manager] poll cycle failed for ${accountKey}:`, error);
    }
  }
}

/**
 * Manages every trade this app has opened (any filled ExecutedTrade, regardless of
 * whether it was opened by auto-execution or a manual click) -- runs unconditionally,
 * independent of engine mode or the kill switch, both of which only govern OPENING new
 * trades, never managing risk already on the table. Each account's own
 * positionManagementEnabled config is the actual on/off switch.
 */
export function startPositionManager(): void {
  if (globalState.started) return;
  globalState.started = true;
  setInterval(() => {
    void runPollCycle();
  }, POLL_INTERVAL_MS);
}
