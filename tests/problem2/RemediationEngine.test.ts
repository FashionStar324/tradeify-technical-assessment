import { RemediationEngine } from '../../src/problem2/RemediationEngine';
import type { AccountBalance, TradeRecord } from '../../src/common/types';

const OUTAGE_START = '2026-03-10T14:30:00.000Z';
const OUTAGE_END = '2026-03-10T14:48:00.000Z';

function makeTrade(id: string, pnlPositive: boolean, overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: id,
    account_id: 'TRD-TEST',
    instrument: 'ESM4',
    entry_price: pnlPositive ? 5200 : 5210,
    exit_price: pnlPositive ? 5210 : 5200, // +500 or -500
    qty: 1,
    entry_time: '2026-03-10T14:32:00.000Z',
    exit_time: '2026-03-10T14:40:00.000Z',
    ...overrides,
  };
}

function makeBalance(accountId = 'TRD-TEST', balance = 50_000): AccountBalance {
  return { account_id: accountId, balance, last_updated: new Date().toISOString() };
}

describe('RemediationEngine', () => {
  describe('basic remediation', () => {
    it('remediates a single losing trade', async () => {
      const trades = [makeTrade('T-001', false)]; // -500 PnL
      const balances = [makeBalance()];
      const engine = new RemediationEngine(trades, balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END);

      expect(report.losing_trades_remediated).toBe(1);
      expect(report.total_balance_adjustments).toBeCloseTo(500);
      expect(engine.getBalance('TRD-TEST')!.balance).toBeCloseTo(50_500);
    });

    it('does NOT remediate a profitable trade', async () => {
      const trades = [makeTrade('T-001', true)]; // +500 PnL
      const balances = [makeBalance()];
      const engine = new RemediationEngine(trades, balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END);

      expect(report.losing_trades_remediated).toBe(0);
      expect(report.profitable_trades).toBe(1);
      expect(engine.getBalance('TRD-TEST')!.balance).toBe(50_000); // unchanged
    });

    it('does NOT touch trades outside the outage window', async () => {
      const outsideTrade = makeTrade('T-OUT', false, {
        entry_time: '2026-03-10T15:00:00.000Z',
        exit_time: '2026-03-10T15:10:00.000Z',
      });
      const balances = [makeBalance()];
      const engine = new RemediationEngine([outsideTrade], balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END);

      expect(report.total_trades_during_window).toBe(0);
      expect(engine.getBalance('TRD-TEST')!.balance).toBe(50_000);
    });
  });

  describe('idempotency', () => {
    it('does not double-remediate on second run', async () => {
      const trades = [makeTrade('T-001', false)];
      const balances = [makeBalance()];
      const engine = new RemediationEngine(trades, balances);

      const report1 = await engine.run(OUTAGE_START, OUTAGE_END);
      const report2 = await engine.run(OUTAGE_START, OUTAGE_END);

      expect(report1.losing_trades_remediated).toBe(1);
      expect(report2.losing_trades_remediated).toBe(0);
      expect(report2.already_remediated).toBe(1);
      // Balance was adjusted exactly once
      expect(engine.getBalance('TRD-TEST')!.balance).toBeCloseTo(50_500);
    });

    it('skips pre-existing remediated trades', async () => {
      const trade = makeTrade('T-PRE', false, { remediated: true, remediation_run_id: 'PRIOR' });
      const balances = [makeBalance()];
      const engine = new RemediationEngine([trade], balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END);

      expect(report.already_remediated).toBe(1);
      expect(report.losing_trades_remediated).toBe(0);
      expect(engine.getBalance('TRD-TEST')!.balance).toBe(50_000);
    });
  });

  describe('dry run', () => {
    it('does not mutate state in dry run mode', async () => {
      const trades = [makeTrade('T-001', false)];
      const balances = [makeBalance()];
      const engine = new RemediationEngine(trades, balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END, { dryRun: true });

      expect(report.dry_run).toBe(true);
      expect(report.losing_trades_remediated).toBe(1); // would have remediated
      expect(engine.getBalance('TRD-TEST')!.balance).toBe(50_000); // unchanged
      // Trade not marked
      expect(trades[0]?.remediated).toBeUndefined();
    });
  });

  describe('audit log', () => {
    it('writes audit entries for every action', async () => {
      const trades = [makeTrade('T-001', false), makeTrade('T-002', true)];
      const balances = [makeBalance()];
      const engine = new RemediationEngine(trades, balances);

      await engine.run(OUTAGE_START, OUTAGE_END);

      const log = engine.getAuditLog();
      expect(log.length).toBeGreaterThan(0);

      const actionTypes = log.map((e) => e.action);
      expect(actionTypes).toContain('TRADE_IDENTIFIED');
      expect(actionTypes).toContain('TRADE_REMEDIATED');
      expect(actionTypes).toContain('TRADE_SKIPPED');
      expect(actionTypes).toContain('BALANCE_ADJUSTED');
    });

    it('all audit entries share the same run_id', async () => {
      const trades = [makeTrade('T-001', false)];
      const balances = [makeBalance()];
      const engine = new RemediationEngine(trades, balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END);
      const log = engine.getAuditLog();
      const runIds = new Set(log.map((e) => e.run_id));

      expect(runIds.size).toBe(1);
      expect(runIds.has(report.run_id)).toBe(true);
    });
  });

  describe('multi-account scenario', () => {
    it('tracks accounts impacted correctly', async () => {
      const trades = [
        makeTrade('T-A1', false, { account_id: 'ACC-1' }),
        makeTrade('T-A2', false, { account_id: 'ACC-2' }),
        makeTrade('T-A3', true, { account_id: 'ACC-3' }),
      ];
      const balances = [makeBalance('ACC-1'), makeBalance('ACC-2'), makeBalance('ACC-3')];
      const engine = new RemediationEngine(trades, balances);

      const report = await engine.run(OUTAGE_START, OUTAGE_END);

      expect(report.accounts_impacted).toHaveLength(2);
      expect(report.accounts_impacted).toContain('ACC-1');
      expect(report.accounts_impacted).toContain('ACC-2');
      expect(report.accounts_impacted).not.toContain('ACC-3'); // profitable, not remediated
    });
  });
});
