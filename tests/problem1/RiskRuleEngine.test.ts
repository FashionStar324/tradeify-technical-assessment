import { AccountStateEngine } from '../../src/problem1/engine/AccountStateEngine';
import { RiskRuleEngine } from '../../src/problem1/engine/RiskRuleEngine';
import type { AccountState, ExecutionEvent } from '../../src/common/types';

function makeState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    account_id: 'TRD-TEST',
    positions: {},
    total_net_position: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    daily_pnl: 0,
    peak_daily_pnl: 0,
    trade_count: 0,
    winning_trades: 0,
    win_rate: 0,
    risk_status: 'OK',
    violations: [],
    locked: false,
    last_updated: new Date().toISOString(),
    ...overrides,
  };
}

function makeExec(qty = 2): ExecutionEvent {
  return {
    broker: 'Broker_A',
    account_id: 'TRD-TEST',
    instrument: 'NQH4',
    side: 'BUY',
    qty,
    price: 18200,
    timestamp: new Date().toISOString(),
    execution_id: 'exec-test',
  };
}

describe('RiskRuleEngine', () => {
  let engine: RiskRuleEngine;

  beforeEach(() => {
    engine = new RiskRuleEngine();
  });

  // ── OK status ──────────────────────────────────────────────────────────────

  it('returns OK for a clean state', () => {
    const state = makeState();
    engine.evaluate(state);
    expect(state.risk_status).toBe('OK');
    expect(state.violations).toHaveLength(0);
  });

  // ── WARNING status (80% thresholds) ───────────────────────────────────────

  it('sets WARNING when daily_pnl crosses 80% of max daily loss', () => {
    // 80% of -2500 = -2000
    const state = makeState({ daily_pnl: -2001, peak_daily_pnl: -2001 });
    engine.evaluate(state);
    expect(state.risk_status).toBe('WARNING');
    expect(state.violations).toHaveLength(0);
  });

  it('sets WARNING when position crosses 80% of max (8 contracts)', () => {
    const state = makeState({ total_net_position: 8 });
    engine.evaluate(state);
    expect(state.risk_status).toBe('WARNING');
  });

  it('sets WARNING when trailing drawdown crosses 80% ($2400)', () => {
    // peak=3000, current=600 → drawdown=2400
    const state = makeState({ peak_daily_pnl: 3000, daily_pnl: 600 });
    engine.evaluate(state);
    expect(state.risk_status).toBe('WARNING');
  });

  it('sets WARNING when execution qty is 4 (80% of 5)', () => {
    const state = makeState();
    engine.evaluate(state, makeExec(4));
    expect(state.risk_status).toBe('WARNING');
  });

  // ── VIOLATED status ────────────────────────────────────────────────────────

  it('flags MAX_DAILY_LOSS when daily_pnl <= -2500', () => {
    const state = makeState({ daily_pnl: -2500, peak_daily_pnl: -2500 });
    engine.evaluate(state);
    expect(state.risk_status).toBe('VIOLATED');
    expect(state.violations.find((v) => v.rule === 'MAX_DAILY_LOSS')).toBeDefined();
  });

  it('does NOT flag MAX_DAILY_LOSS for -2499', () => {
    const state = makeState({ daily_pnl: -2499, peak_daily_pnl: -2499 });
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'MAX_DAILY_LOSS')).toBeUndefined();
  });

  it('flags MAX_POSITION_SIZE when total_net_position > 10', () => {
    const state = makeState({ total_net_position: 11 });
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'MAX_POSITION_SIZE')).toBeDefined();
  });

  it('does NOT flag MAX_POSITION_SIZE for exactly 10', () => {
    const state = makeState({ total_net_position: 10 });
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'MAX_POSITION_SIZE')).toBeUndefined();
  });

  it('flags MAX_CONTRACTS_PER_TRADE when execution qty > 5', () => {
    const state = makeState();
    engine.evaluate(state, makeExec(6));
    expect(state.violations.find((v) => v.rule === 'MAX_CONTRACTS_PER_TRADE')).toBeDefined();
  });

  it('does NOT flag MAX_CONTRACTS_PER_TRADE for qty = 5', () => {
    const state = makeState();
    engine.evaluate(state, makeExec(5));
    expect(state.violations.find((v) => v.rule === 'MAX_CONTRACTS_PER_TRADE')).toBeUndefined();
  });

  it('flags TRAILING_DRAWDOWN when drawdown >= 3000', () => {
    const state = makeState({ peak_daily_pnl: 5000, daily_pnl: 2000 });
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'TRAILING_DRAWDOWN')).toBeDefined();
  });

  it('can have multiple simultaneous violations', () => {
    const state = makeState({ daily_pnl: -3000, total_net_position: 15 });
    engine.evaluate(state, makeExec(6));
    expect(state.violations.length).toBeGreaterThanOrEqual(3);
    expect(state.risk_status).toBe('VIOLATED');
  });

  // ── Violation clearing ─────────────────────────────────────────────────────

  it('clears violations when account recovers below threshold', () => {
    const state = makeState({ daily_pnl: -2500, peak_daily_pnl: -2500 });
    engine.evaluate(state);
    expect(state.violations).toHaveLength(1);

    // Recover above threshold
    state.daily_pnl = -1000;
    state.peak_daily_pnl = -1000;
    engine.evaluate(state);
    expect(state.violations).toHaveLength(0);
    expect(state.risk_status).toBe('OK');
  });

  it('clears position violation when position drops back to safe level', () => {
    const state = makeState({ total_net_position: 11 });
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'MAX_POSITION_SIZE')).toBeDefined();

    state.total_net_position = 5;
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'MAX_POSITION_SIZE')).toBeUndefined();
  });

  // ── Lock behaviour ─────────────────────────────────────────────────────────

  it('locks account on MAX_DAILY_LOSS', () => {
    const state = makeState({ daily_pnl: -2500, peak_daily_pnl: -2500 });
    engine.evaluate(state);
    expect(state.locked).toBe(true);
  });

  it('locks account on TRAILING_DRAWDOWN', () => {
    const state = makeState({ peak_daily_pnl: 5000, daily_pnl: 2000 });
    engine.evaluate(state);
    expect(state.locked).toBe(true);
  });

  it('does NOT lock account for MAX_POSITION_SIZE alone', () => {
    const state = makeState({ total_net_position: 15 });
    engine.evaluate(state);
    expect(state.locked).toBe(false);
  });

  // ── Events ────────────────────────────────────────────────────────────────

  it('emits violation event only once per new rule', () => {
    const state = makeState({ daily_pnl: -2600, peak_daily_pnl: -2600 });
    const calls: string[] = [];
    engine.on('violation', (msg: string) => calls.push(msg));

    engine.evaluate(state); // first time → emits
    engine.evaluate(state); // second time with same violation → no new emit
    expect(calls).toHaveLength(1);
  });

  it('emits violation event', (done) => {
    const state = makeState({ daily_pnl: -2600, peak_daily_pnl: -2600 });
    engine.once('violation', (msg: string) => {
      expect(msg).toContain('TRD-TEST');
      done();
    });
    engine.evaluate(state);
  });

  // ── Integration with AccountStateEngine ───────────────────────────────────

  it('integrates with AccountStateEngine', () => {
    const accountEngine = new AccountStateEngine();
    const exec: ExecutionEvent = {
      broker: 'B', account_id: 'TRD-A', instrument: 'NQH4',
      side: 'BUY', qty: 6, price: 18200,
      timestamp: new Date().toISOString(), execution_id: 'e1',
    };
    accountEngine.handleExecution(exec);
    const state = accountEngine.getAccount('TRD-A')!;
    engine.evaluate(state, exec);
    expect(state.violations.find((v) => v.rule === 'MAX_CONTRACTS_PER_TRADE')).toBeDefined();
  });
});
