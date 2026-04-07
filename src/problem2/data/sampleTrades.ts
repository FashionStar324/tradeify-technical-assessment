import type { AccountBalance, TradeRecord } from '../../common/types';

/**
 * Simulated trade history for the remediation scenario.
 *
 * Outage window: 09:30:00 → 09:48:00 EST (2026-03-10)
 * = UTC 14:30:00 → 14:48:00
 *
 * Trades are a mix of:
 *   - Inside the outage window (impacted)
 *   - Outside the window (clean)
 *   - One already-remediated trade (to test idempotency)
 */
export const OUTAGE_START = '2026-03-10T14:30:00.000Z';
export const OUTAGE_END = '2026-03-10T14:48:00.000Z';

export const SAMPLE_TRADES: TradeRecord[] = [
  // ── Inside outage window ──────────────────────────────────────────────────
  {
    trade_id: 'T-883721',
    account_id: 'TRD-44821',
    instrument: 'ESM4',
    entry_price: 5201.25,
    exit_price: 5198.00,
    qty: 2,
    entry_time: '2026-03-10T14:32:04.000Z',
    exit_time: '2026-03-10T14:34:02.000Z',
  },
  {
    trade_id: 'T-883722',
    account_id: 'TRD-44821',
    instrument: 'ESM4',
    entry_price: 5195.00,
    exit_price: 5200.50,
    qty: 1,
    entry_time: '2026-03-10T14:35:10.000Z',
    exit_time: '2026-03-10T14:37:00.000Z',
  },
  {
    trade_id: 'T-883730',
    account_id: 'TRD-88312',
    instrument: 'NQH4',
    entry_price: 18250.00,
    exit_price: 18230.00,
    qty: 3,
    entry_time: '2026-03-10T14:31:00.000Z',
    exit_time: '2026-03-10T14:40:00.000Z',
  },
  {
    trade_id: 'T-883731',
    account_id: 'TRD-88312',
    instrument: 'NQH4',
    entry_price: 18220.00,
    exit_price: 18245.00,
    qty: 2,
    entry_time: '2026-03-10T14:42:00.000Z',
    exit_time: '2026-03-10T14:46:00.000Z',
  },
  {
    trade_id: 'T-883740',
    account_id: 'TRD-55901',
    instrument: 'ESM4',
    entry_price: 5205.00,
    exit_price: 5202.25,
    qty: 4,
    entry_time: '2026-03-10T14:33:00.000Z',
    exit_time: '2026-03-10T14:45:00.000Z',
  },
  {
    trade_id: 'T-883741',
    account_id: 'TRD-55901',
    instrument: 'ESM4',
    entry_price: 5198.00,
    exit_price: 5199.50,
    qty: 2,
    entry_time: '2026-03-10T14:38:00.000Z',
    exit_time: '2026-03-10T14:47:00.000Z',
  },
  // Trade with entry before outage, exit inside — partial impact
  {
    trade_id: 'T-883750',
    account_id: 'TRD-22401',
    instrument: 'NQH4',
    entry_price: 18260.00,
    exit_price: 18240.00,
    qty: 1,
    entry_time: '2026-03-10T14:25:00.000Z', // before outage
    exit_time: '2026-03-10T14:35:00.000Z',  // inside outage
  },
  // Already remediated — must be skipped (idempotency)
  {
    trade_id: 'T-883760',
    account_id: 'TRD-67734',
    instrument: 'ESM4',
    entry_price: 5210.00,
    exit_price: 5205.00,
    qty: 2,
    entry_time: '2026-03-10T14:36:00.000Z',
    exit_time: '2026-03-10T14:44:00.000Z',
    remediated: true,
    remediation_run_id: 'RUN-PRIOR-001',
  },

  // ── Outside outage window (clean trades — must NOT be touched) ────────────
  {
    trade_id: 'T-884001',
    account_id: 'TRD-44821',
    instrument: 'ESM4',
    entry_price: 5215.00,
    exit_price: 5212.00,
    qty: 2,
    entry_time: '2026-03-10T15:10:00.000Z',
    exit_time: '2026-03-10T15:15:00.000Z',
  },
  {
    trade_id: 'T-884002',
    account_id: 'TRD-88312',
    instrument: 'NQH4',
    entry_price: 18280.00,
    exit_price: 18300.00,
    qty: 1,
    entry_time: '2026-03-10T15:20:00.000Z',
    exit_time: '2026-03-10T15:25:00.000Z',
  },
];

/** Starting balances per account (before remediation day) */
export const ACCOUNT_BALANCES: AccountBalance[] = [
  { account_id: 'TRD-44821', balance: 50_000, last_updated: '2026-03-10T14:00:00.000Z' },
  { account_id: 'TRD-88312', balance: 75_000, last_updated: '2026-03-10T14:00:00.000Z' },
  { account_id: 'TRD-55901', balance: 60_000, last_updated: '2026-03-10T14:00:00.000Z' },
  { account_id: 'TRD-22401', balance: 45_000, last_updated: '2026-03-10T14:00:00.000Z' },
  { account_id: 'TRD-67734', balance: 55_000, last_updated: '2026-03-10T14:00:00.000Z' },
];
