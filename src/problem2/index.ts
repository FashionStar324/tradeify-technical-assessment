/**
 * Problem 2 standalone runner.
 * Run: npm run dev:p2
 */
import { logger } from '../common/logger';
import { ACCOUNT_BALANCES, OUTAGE_END, OUTAGE_START, SAMPLE_TRADES } from './data/sampleTrades';
import { ReconciliationEngine } from './ReconciliationEngine';
import { RemediationEngine } from './RemediationEngine';

async function main(): Promise<void> {
  logger.info('═'.repeat(60));
  logger.info('  Problem 2 — Brokerage Outage Remediation Engine');
  logger.info('═'.repeat(60));

  // Deep-clone data so reruns are independent
  const trades = SAMPLE_TRADES.map((t) => ({ ...t }));
  const balances = ACCOUNT_BALANCES.map((b) => ({ ...b }));

  const engine = new RemediationEngine(trades, balances);

  // ── First pass: dry run ───────────────────────────────────────────────────
  logger.info('\n[DRY RUN]');
  await engine.run(OUTAGE_START, OUTAGE_END, { dryRun: true });

  // ── Second pass: live run ─────────────────────────────────────────────────
  logger.info('\n[LIVE RUN]');
  const report = await engine.run(OUTAGE_START, OUTAGE_END);

  // ── Third pass: re-run to verify idempotency ──────────────────────────────
  logger.info('\n[IDEMPOTENCY CHECK — re-running same remediation]');
  const report2 = await engine.run(OUTAGE_START, OUTAGE_END);
  logger.info(
    `Idempotency OK: second run remediated ${report2.losing_trades_remediated} trades ` +
    `(expected 0, already_remediated=${report2.already_remediated})`,
  );

  // ── Reconciliation ────────────────────────────────────────────────────────
  logger.info('\n[RECONCILIATION]');
  const recon = new ReconciliationEngine();
  const currentBalances = ACCOUNT_BALANCES.map((orig) => {
    return engine.getBalance(orig.account_id) ?? orig;
  });
  recon.reconcile(currentBalances);

  // ── Audit log summary ─────────────────────────────────────────────────────
  logger.info(`\n[AUDIT LOG] Total entries: ${engine.getAuditLog().length}`);
  logger.info(`  Run ${report.run_id} → ${engine.getAuditLog().length} audit entries`);
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
