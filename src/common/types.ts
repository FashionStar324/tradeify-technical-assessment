// ─── Shared Types ────────────────────────────────────────────────────────────

export type Side = 'BUY' | 'SELL';
export type RiskStatus = 'OK' | 'WARNING' | 'VIOLATED';

// ─── Problem 1: Event Stream Types ───────────────────────────────────────────

export interface ExecutionEvent {
  broker: string;
  account_id: string;
  instrument: string;
  side: Side;
  qty: number;
  price: number;
  timestamp: string;
  execution_id: string;
  /** Monotonically increasing per-broker sequence number for out-of-order detection */
  seq?: number;
}

export interface PositionUpdate {
  broker: string;
  account_id: string;
  instrument: string;
  position_qty: number;
  avg_price: number;
  timestamp: string;
}

export interface MarketPriceFeed {
  instrument: string;
  price: number;
  timestamp: string;
}

export type BrokerEvent =
  | { type: 'execution'; payload: ExecutionEvent }
  | { type: 'position'; payload: PositionUpdate }
  | { type: 'market'; payload: MarketPriceFeed };

// ─── Problem 1: Account State ─────────────────────────────────────────────────

export interface InstrumentPosition {
  instrument: string;
  position_qty: number; // positive = long, negative = short
  avg_price: number;
  realized_pnl: number;
  unrealized_pnl: number;
}

export interface RiskViolation {
  rule: string;
  message: string;
  timestamp: string;
  value: number;
  threshold: number;
}

export interface AccountState {
  account_id: string;
  positions: Record<string, InstrumentPosition>; // keyed by instrument
  total_net_position: number; // sum of abs(position_qty) across instruments
  realized_pnl: number;
  unrealized_pnl: number;
  daily_pnl: number;
  peak_daily_pnl: number; // for trailing drawdown tracking
  trade_count: number;
  winning_trades: number;
  win_rate: number;
  risk_status: RiskStatus;
  violations: RiskViolation[];
  /**
   * When true, the account has hit a critical risk limit (MAX_DAILY_LOSS or
   * TRAILING_DRAWDOWN). New execution events are rejected until manually unlocked.
   */
  locked: boolean;
  last_updated: string;
}

/** Serialisable snapshot pushed over WebSocket */
export interface AccountSnapshot {
  account_id: string;
  positions: Array<{
    instrument: string;
    position_qty: number;
    avg_price: number;
    unrealized_pnl: number;
  }>;
  total_net_position: number;
  realized_pnl: number;
  unrealized_pnl: number;
  daily_pnl: number;
  trade_count: number;
  win_rate: number;
  risk_status: RiskStatus;
  violations: string[];
  locked: boolean;
  last_updated: string;
}

// ─── Problem 2: Trade Remediation Types ──────────────────────────────────────

export interface TradeRecord {
  trade_id: string;
  account_id: string;
  instrument: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  entry_time: string;
  exit_time: string;
  pnl?: number;
  remediated?: boolean;
  remediation_run_id?: string;
}

export interface AccountBalance {
  account_id: string;
  balance: number;
  last_updated: string;
}

export interface RemediationResult {
  trade_id: string;
  account_id: string;
  instrument: string;
  pnl: number;
  balance_adjustment: number;
  remediated: boolean;
  skipped_reason?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  run_id: string;
  action: 'TRADE_IDENTIFIED' | 'TRADE_REMEDIATED' | 'TRADE_SKIPPED' | 'BALANCE_ADJUSTED' | 'RECONCILIATION_CHECK' | 'RECONCILIATION_DISCREPANCY';
  entity_type: 'TRADE' | 'ACCOUNT';
  entity_id: string;
  details: Record<string, unknown>;
}

export interface RemediationReport {
  run_id: string;
  timestamp: string;
  outage_window: { start: string; end: string };
  total_trades_during_window: number;
  profitable_trades: number;
  losing_trades_remediated: number;
  already_remediated: number;
  total_balance_adjustments: number;
  accounts_impacted: string[];
  dry_run: boolean;
}

export interface ReconciliationDiff {
  account_id: string;
  internal_balance: number;
  broker_balance: number;
  discrepancy: number;
  status: 'MATCH' | 'MISMATCH';
}

export interface ReconciliationSummary {
  diffs: ReconciliationDiff[];
  total_accounts: number;
  matched: number;
  mismatched: number;
  result: 'PASSED' | 'FAILED';
  timestamp: string;
}
