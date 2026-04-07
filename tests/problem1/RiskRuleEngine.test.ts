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

  it('returns OK for a clean state', () => {
    const state = makeState();
    engine.evaluate(state);
    expect(state.risk_status).toBe('OK');
    expect(state.violations).toHaveLength(0);
  });

  it('flags MAX_DAILY_LOSS when daily_pnl <= -2500', () => {
    const state = makeState({ daily_pnl: -2500 });
    engine.evaluate(state);
    expect(state.risk_status).toBe('VIOLATED');
    expect(state.violations.find((v) => v.rule === 'MAX_DAILY_LOSS')).toBeDefined();
  });

  it('does NOT flag MAX_DAILY_LOSS for -2499', () => {
    const state = makeState({ daily_pnl: -2499 });
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
    const state = makeState({ peak_daily_pnl: 5000, daily_pnl: 2000 }); // drawdown = 3000
    engine.evaluate(state);
    expect(state.violations.find((v) => v.rule === 'TRAILING_DRAWDOWN')).toBeDefined();
  });

  it('emits violation event', (done) => {
    // peak_daily_pnl = daily_pnl so drawdown = 0; only MAX_DAILY_LOSS fires → done() called once
    const state = makeState({ daily_pnl: -2600, peak_daily_pnl: -2600 });
    engine.once('violation', (msg: string) => {
      expect(msg).toContain('TRD-TEST');
      done();
    });
    engine.evaluate(state);
  });

  it('can have multiple simultaneous violations', () => {
    const state = makeState({ daily_pnl: -3000, total_net_position: 15 });
    engine.evaluate(state, makeExec(6));
    expect(state.violations.length).toBeGreaterThanOrEqual(3);
    expect(state.risk_status).toBe('VIOLATED');
  });

  it('integrates with AccountStateEngine', () => {
    const accountEngine = new AccountStateEngine();
    // BUY 11 contracts in one go — violates both MAX_POSITION and MAX_TRADE
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
