import type { AccountKey, ExecutedTrade } from "./types";
import { loadExecutionConfig } from "./executionConfig";
import { getOpenPositions, isAccountConfigured, modifyPosition } from "./metaApiConnection";
import { positionStore } from "./positionStore";

export interface PositionManagementConfig {
  breakEvenTriggerR: number;
  trailingArmTriggerR: number;
  trailingDistanceFractionOfStop: number;
}

export interface PositionManagementState {
  breakEvenApplied: boolean;
  trailingArmed: boolean;
}

export type PositionManagementAction =
  | { type: "none" }
  | { type: "break_even"; newStopLoss: number }
  | { type: "arm_trailing"; distance: number };

/**
 * Pure -- R is always computed off the trade's OWN original entry/stop (never a live,
 * possibly-already-moved stop loss), so the threshold math can't drift as the position
 * itself gets managed. Once trailing is armed the broker owns the stop from then on --
 * break-even is never (re-)applied afterward, since doing so could move a broker-ratcheted
 * trailing stop backward to a worse (less protective) level.
 */
export function evaluatePositionForManagement(
  trade: ExecutedTrade,
  currentPrice: number,
  config: PositionManagementConfig,
  state: PositionManagementState
): PositionManagementAction {
  const stopDistance = Math.abs(trade.requestedEntry - trade.stopLoss);
  if (stopDistance <= 0) return { type: "none" };

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
    const positionState = globalState.positionStates.get(stateKey) ?? { breakEvenApplied: false, trailingArmed: false };

    const managementConfig: PositionManagementConfig = {
      breakEvenTriggerR: config.breakEvenTriggerR,
      trailingArmTriggerR: config.trailingArmTriggerR,
      trailingDistanceFractionOfStop: config.trailingDistanceFractionOfStop,
    };
    const action = evaluatePositionForManagement(trade, live.currentPrice, managementConfig, positionState);
    if (action.type === "none") continue;

    if (action.type === "break_even") {
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
        globalState.positionStates.set(stateKey, { breakEvenApplied: true, trailingArmed: true });
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
