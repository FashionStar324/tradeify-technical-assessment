import { v4 as uuidv4 } from 'uuid';
import { logger } from '../common/logger';
import { AuditLogger } from './AuditLogger';
import { calculateTradePnL, isInOutageWindow } from './PnLCalculator';
import type {
  AccountBalance,
  RemediationReport,
  RemediationResult,
  TradeRecord,
} from '../common/types';

export interface RemediationOptions {
  /** When true, compute and log but do NOT mutate balances or mark trades */
  dryRun?: boolean;
}

/**
 * Orchestrates the brokerage outage remediation process.
 *
 * Guarantees:
 *   1. Idempotency  — trades already marked `remediated` are skipped.
 *   2. No double    — each trade carries its remediation_run_id once processed.
 *   3. Audit trail  — every action is written to the AuditLogger before
 *                     any balance mutation occurs (WAL-like pattern).
 *   4. Determinism  — given the same input set, reruns produce the same output.
 */
export class RemediationEngine {
  private readonly auditLogger = new AuditLogger();

  constructor(
    private trades: TradeRecord[],
    private balances: AccountBalance[],
  ) {}

  async run(
    windowStart: string,
    windowEnd: string,
    options: RemediationOptions = {},
  ): Promise<RemediationReport> {
    const runId = uuidv4();
    const dryRun = options.dryRun ?? false;

    logger.info(
      `[RemediationEngine] Starting run ${runId} | window: ${windowStart} → ${windowEnd} | dryRun=${dryRun}`,
    );

    // ── Step 1: Identify impacted trades ─────────────────────────────────────
    const impacted = this.trades.filter((t) =>
      isInOutageWindow(t, windowStart, windowEnd),
    );

    this.auditLogger.log({
      run_id: runId,
      action: 'TRADE_IDENTIFIED',
      entity_type: 'TRADE',
      entity_id: 'BATCH',
      details: {
        total_impacted: impacted.length,
        trade_ids: impacted.map((t) => t.trade_id),
        window: { start: windowStart, end: windowEnd },
      },
    });

    // ── Step 2 & 3: Calculate PnL, remediate losing trades ───────────────────
    const results: RemediationResult[] = [];
    let alreadyRemediated = 0;

    for (const trade of impacted) {
      const pnl = calculateTradePnL(trade);

      // Idempotency check
      if (trade.remediated) {
        alreadyRemediated++;
        results.push({
          trade_id: trade.trade_id,
          account_id: trade.account_id,
          instrument: trade.instrument,
          pnl,
          balance_adjustment: 0,
          remediated: false,
          skipped_reason: `Already remediated in run ${trade.remediation_run_id}`,
        });
        this.auditLogger.log({
          run_id: runId,
          action: 'TRADE_SKIPPED',
          entity_type: 'TRADE',
          entity_id: trade.trade_id,
          details: { reason: 'already_remediated', prior_run_id: trade.remediation_run_id },
        });
        continue;
      }

      if (pnl >= 0) {
        // Profitable trade — leave untouched
        results.push({
          trade_id: trade.trade_id,
          account_id: trade.account_id,
          instrument: trade.instrument,
          pnl,
          balance_adjustment: 0,
          remediated: false,
          skipped_reason: 'Profitable trade — not remediated',
        });
        this.auditLogger.log({
          run_id: runId,
          action: 'TRADE_SKIPPED',
          entity_type: 'TRADE',
          entity_id: trade.trade_id,
          details: { reason: 'profitable', pnl },
        });
        continue;
      }

      // Losing trade — reverse it
      const balanceAdjustment = -pnl; // positive amount to restore

      // Write audit entry BEFORE mutation (WAL pattern)
      this.auditLogger.log({
        run_id: runId,
        action: 'TRADE_REMEDIATED',
        entity_type: 'TRADE',
        entity_id: trade.trade_id,
        details: {
          pnl,
          balance_adjustment: balanceAdjustment,
          account_id: trade.account_id,
          instrument: trade.instrument,
          dry_run: dryRun,
        },
      });

      if (!dryRun) {
        // Mark trade as remediated
        trade.remediated = true;
        trade.remediation_run_id = runId;

        // Adjust account balance
        this.adjustBalance(trade.account_id, balanceAdjustment, runId);
      }

      logger.info(
        `[RemediationEngine] TRADE ${trade.trade_id} REMEDIATED | ` +
        `ACCOUNT ${trade.account_id} BALANCE ADJUSTED +${balanceAdjustment.toFixed(2)}`,
      );

      results.push({
        trade_id: trade.trade_id,
        account_id: trade.account_id,
        instrument: trade.instrument,
        pnl,
        balance_adjustment: balanceAdjustment,
        remediated: true,
      });
    }

    // ── Step 4: Build report ──────────────────────────────────────────────────
    const remediated = results.filter((r) => r.remediated);
    const profitable = results.filter((r) => (r.pnl ?? 0) >= 0 && !r.remediated && !r.skipped_reason?.includes('Already'));
    const totalAdjustment = remediated.reduce((sum, r) => sum + r.balance_adjustment, 0);
    const accountsImpacted = [...new Set(remediated.map((r) => r.account_id))];

    const report: RemediationReport = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      outage_window: { start: windowStart, end: windowEnd },
      total_trades_during_window: impacted.length,
      profitable_trades: profitable.length,
      losing_trades_remediated: remediated.length,
      already_remediated: alreadyRemediated,
      total_balance_adjustments: totalAdjustment,
      accounts_impacted: accountsImpacted,
      dry_run: dryRun,
    };

    this.printReport(report);
    return report;
  }

  getAuditLog(): ReturnType<AuditLogger['getAll']> {
    return this.auditLogger.getAll();
  }

  getBalance(accountId: string): AccountBalance | undefined {
    return this.balances.find((b) => b.account_id === accountId);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private adjustBalance(accountId: string, amount: number, runId: string): void {
    const balance = this.balances.find((b) => b.account_id === accountId);
    if (!balance) {
      logger.warn(`[RemediationEngine] Unknown account ${accountId} — skipping balance update`);
      return;
    }

    this.auditLogger.log({
      run_id: runId,
      action: 'BALANCE_ADJUSTED',
      entity_type: 'ACCOUNT',
      entity_id: accountId,
      details: {
        before: balance.balance,
        adjustment: amount,
        after: balance.balance + amount,
      },
    });

    balance.balance += amount;
    balance.last_updated = new Date().toISOString();
  }

  private printReport(report: RemediationReport): void {
    logger.info('─'.repeat(60));
    logger.info(`Outage Window: ${report.outage_window.start} → ${report.outage_window.end}`);
    logger.info(`Total Trades During Window:  ${report.total_trades_during_window}`);
    logger.info(`Profitable Trades:           ${report.profitable_trades}`);
    logger.info(`Already Remediated (skipped):${report.already_remediated}`);
    logger.info(`Losing Trades Remediated:    ${report.losing_trades_remediated}`);
    logger.info(`Total Balance Adjustments:   $${report.total_balance_adjustments.toFixed(2)}`);
    logger.info(`Accounts Impacted:           ${report.accounts_impacted.length}`);
    if (report.dry_run) logger.warn('*** DRY RUN — no state was mutated ***');
    logger.info('─'.repeat(60));
  }
}
