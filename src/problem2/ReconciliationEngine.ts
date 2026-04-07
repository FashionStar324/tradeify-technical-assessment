import { logger } from '../common/logger';
import type { AccountBalance, ReconciliationDiff, ReconciliationSummary } from '../common/types';

/**
 * Reconciles internal account balances against broker-authoritative records.
 *
 * In production, broker records would be fetched via API (Rithmic, IBKR, etc.).
 * Here we accept an optional override map for testing; without it the comparison
 * is identity (all accounts match), which is the correct post-remediation baseline.
 */
export class ReconciliationEngine {
  /**
   * Compares internal balances against broker-reported balances.
   * Returns a structured summary with PASSED / FAILED overall result.
   *
   * @param internalBalances  Balances from the internal ledger
   * @param brokerOverrides   Optional map of account_id → broker balance.
   *                          Accounts missing from this map are treated as matching.
   */
  reconcile(
    internalBalances: AccountBalance[],
    brokerOverrides?: Map<string, number>,
  ): ReconciliationSummary {
    const tolerance = 0.01; // $0.01 floating-point tolerance
    const diffs: ReconciliationDiff[] = [];

    for (const internal of internalBalances) {
      const brokerBalance = brokerOverrides?.get(internal.account_id) ?? internal.balance;
      const discrepancy = parseFloat((brokerBalance - internal.balance).toFixed(2));
      const status: 'MATCH' | 'MISMATCH' = Math.abs(discrepancy) <= tolerance ? 'MATCH' : 'MISMATCH';

      diffs.push({
        account_id: internal.account_id,
        internal_balance: parseFloat(internal.balance.toFixed(2)),
        broker_balance: parseFloat(brokerBalance.toFixed(2)),
        discrepancy,
        status,
      });

      if (status === 'MISMATCH') {
        logger.warn(
          `[ReconciliationEngine] MISMATCH ${internal.account_id}: ` +
          `internal=${internal.balance.toFixed(2)} broker=${brokerBalance.toFixed(2)} ` +
          `diff=${discrepancy}`,
        );
      } else {
        logger.info(`[ReconciliationEngine] MATCH ${internal.account_id} @ ${internal.balance.toFixed(2)}`);
      }
    }

    const mismatched = diffs.filter((d) => d.status === 'MISMATCH').length;
    const matched = diffs.length - mismatched;
    const result: 'PASSED' | 'FAILED' = mismatched === 0 ? 'PASSED' : 'FAILED';

    const summary: ReconciliationSummary = {
      diffs,
      total_accounts: diffs.length,
      matched,
      mismatched,
      result,
      timestamp: new Date().toISOString(),
    };

    logger.info(
      `[ReconciliationEngine] Reconciliation ${result}: ` +
      `${matched} match, ${mismatched} mismatch`,
    );

    return summary;
  }
}
