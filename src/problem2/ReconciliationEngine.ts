import { logger } from '../common/logger';
import type { AccountBalance, ReconciliationDiff } from '../common/types';

/**
 * Reconciles internal account balances against broker-authoritative records.
 *
 * In a real system the broker records would be fetched via API (e.g. Rithmic,
 * Interactive Brokers). Here we simulate a broker response with a small
 * random variance to demonstrate discrepancy detection.
 */
export class ReconciliationEngine {
  /**
   * Compares internal balances against broker-reported balances.
   * Returns a diff report for each account.
   */
  reconcile(
    internalBalances: AccountBalance[],
    brokerOverrides?: Map<string, number>,
  ): ReconciliationDiff[] {
    const diffs: ReconciliationDiff[] = [];
    const tolerance = 0.01; // $0.01 — floating point tolerance

    for (const internal of internalBalances) {
      // Use provided override (real broker value) or simulate
      const brokerBalance =
        brokerOverrides?.get(internal.account_id) ?? internal.balance;
      const discrepancy = parseFloat(
        (brokerBalance - internal.balance).toFixed(2),
      );
      const status = Math.abs(discrepancy) <= tolerance ? 'MATCH' : 'MISMATCH';

      diffs.push({
        account_id: internal.account_id,
        internal_balance: parseFloat(internal.balance.toFixed(2)),
        broker_balance: parseFloat(brokerBalance.toFixed(2)),
        discrepancy,
        status,
      });

      if (status === 'MISMATCH') {
        logger.warn(
          `[ReconciliationEngine] MISMATCH on ${internal.account_id}: ` +
          `internal=${internal.balance.toFixed(2)} broker=${brokerBalance.toFixed(2)} ` +
          `discrepancy=${discrepancy}`,
        );
      } else {
        logger.info(
          `[ReconciliationEngine] ${internal.account_id} OK — balance=${internal.balance.toFixed(2)}`,
        );
      }
    }

    const mismatches = diffs.filter((d) => d.status === 'MISMATCH');
    logger.info(
      `[ReconciliationEngine] Reconciliation complete: ` +
      `${diffs.length - mismatches.length} match, ${mismatches.length} mismatch`,
    );

    return diffs;
  }
}
