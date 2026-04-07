import { getContractMultiplier } from '../common/config';
import type { TradeRecord } from '../common/types';

/**
 * Calculates the PnL of a completed round-trip trade.
 *
 * Formula: PnL = (exit_price - entry_price) * qty * contract_multiplier
 *
 * A positive value means the trade was profitable.
 * A negative value means the trade was a loss.
 */
export function calculateTradePnL(trade: TradeRecord): number {
  const multiplier = getContractMultiplier(trade.instrument);
  return (trade.exit_price - trade.entry_price) * trade.qty * multiplier;
}

/**
 * Returns true if the trade was impacted by the outage window.
 * A trade is impacted when either its entry_time OR exit_time falls
 * within [windowStart, windowEnd).
 */
export function isInOutageWindow(
  trade: TradeRecord,
  windowStart: string,
  windowEnd: string,
): boolean {
  const entry = new Date(trade.entry_time).getTime();
  const exit = new Date(trade.exit_time).getTime();
  const start = new Date(windowStart).getTime();
  const end = new Date(windowEnd).getTime();
  return (entry >= start && entry < end) || (exit >= start && exit < end);
}
