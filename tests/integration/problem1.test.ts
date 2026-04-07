/**
 * Integration test: wires up the full Problem 1 pipeline without simulators.
 * Manually emits events on the bus and asserts end-to-end behaviour.
 */
import { EventEmitter } from 'events';
import { AccountStateEngine } from '../../src/problem1/engine/AccountStateEngine';
import { RiskRuleEngine } from '../../src/problem1/engine/RiskRuleEngine';
import { EventIngester } from '../../src/problem1/EventIngester';
import type { BrokerEvent, ExecutionEvent } from '../../src/common/types';

function buildPipeline() {
  const bus = new EventEmitter();
  const accountEngine = new AccountStateEngine();
  const riskEngine = new RiskRuleEngine();
  const ingester = new EventIngester(bus, accountEngine, riskEngine);
  ingester.start();
  return { bus, accountEngine, riskEngine, ingester };
}

function execEvent(overrides: Partial<ExecutionEvent> = {}): BrokerEvent {
  return {
    type: 'execution',
    payload: {
      broker: 'Broker_A',
      account_id: 'TRD-INT',
      instrument: 'NQH4',
      side: 'BUY',
      qty: 1,
      price: 18200,
      timestamp: new Date().toISOString(),
      execution_id: `exec-${Math.random()}`,
      ...overrides,
    },
  };
}

describe('Problem 1 — full pipeline integration', () => {
  // Each test gets its own pipeline; afterEach stops the ingester to clean up
  // the EventDeduplicator's eviction timer so Jest has no open handles.
  let pipeline: ReturnType<typeof buildPipeline>;

  beforeEach(() => {
    pipeline = buildPipeline();
  });

  afterEach(() => {
    pipeline.ingester.stop();
    jest.restoreAllMocks();
  });

  it('execution event flows through to account state', () => {
    pipeline.bus.emit('event', execEvent());

    const state = pipeline.accountEngine.getAccount('TRD-INT');
    expect(state).toBeDefined();
    expect(state!.positions['NQH4']?.position_qty).toBe(1);
  });

  it('duplicate execution is ignored', () => {
    const event = execEvent({ execution_id: 'dup-001' });

    pipeline.bus.emit('event', event);
    pipeline.bus.emit('event', event); // duplicate

    expect(pipeline.ingester.getStats().duplicates).toBe(1);
    expect(pipeline.accountEngine.getAccount('TRD-INT')!.positions['NQH4']?.position_qty).toBe(1);
  });

  it('market price event updates unrealized PnL', () => {
    pipeline.bus.emit('event', execEvent({ qty: 2, price: 18200 }));
    pipeline.bus.emit('event', {
      type: 'market',
      payload: { instrument: 'NQH4', price: 18250, timestamp: new Date().toISOString() },
    } satisfies BrokerEvent);

    // 2 * (18250 - 18200) * 20 = 2000
    expect(pipeline.accountEngine.getAccount('TRD-INT')!.unrealized_pnl).toBeCloseTo(2000);
  });

  it('risk violation fires when position exceeds limit', () => {
    const violations: string[] = [];
    pipeline.riskEngine.on('violation', (msg: string) => violations.push(msg));

    // Add 11 contracts across separate trades
    for (let i = 0; i < 11; i++) {
      pipeline.bus.emit('event', execEvent({ execution_id: `e-${i}`, qty: 1, side: 'BUY' }));
    }

    expect(violations.some((v) => v.includes('MAX POSITION SIZE'))).toBe(true);
  });

  it('account is locked after MAX_DAILY_LOSS violation', () => {
    pipeline.bus.emit('event', execEvent());
    const state = pipeline.accountEngine.getAccount('TRD-INT')!;
    state.daily_pnl = -2600;
    state.peak_daily_pnl = -2600;
    pipeline.riskEngine.evaluate(state);

    expect(state.locked).toBe(true);

    // Further executions should be rejected
    const statsBefore = pipeline.accountEngine.getAllAccounts()[0]!.trade_count;
    pipeline.bus.emit('event', execEvent({ execution_id: 'should-be-rejected' }));
    expect(pipeline.accountEngine.getAccount('TRD-INT')!.trade_count).toBe(statsBefore);
  });

  it('position update from broker reconciles state', () => {
    pipeline.bus.emit('event', execEvent({ qty: 3 }));

    // Broker says position is 5 (authoritative)
    pipeline.bus.emit('event', {
      type: 'position',
      payload: {
        broker: 'Broker_A',
        account_id: 'TRD-INT',
        instrument: 'NQH4',
        position_qty: 5,
        avg_price: 18190,
        timestamp: new Date().toISOString(),
      },
    } satisfies BrokerEvent);

    const pos = pipeline.accountEngine.getAccount('TRD-INT')!.positions['NQH4'];
    expect(pos?.position_qty).toBe(5);
    expect(pos?.avg_price).toBe(18190);
  });

  it('ingester stats correctly count processed vs duplicates vs rejected', () => {
    // 3 unique executions
    pipeline.bus.emit('event', execEvent({ execution_id: 'u1' }));
    pipeline.bus.emit('event', execEvent({ execution_id: 'u2' }));
    pipeline.bus.emit('event', execEvent({ execution_id: 'u3' }));
    // 1 duplicate
    pipeline.bus.emit('event', execEvent({ execution_id: 'u1' }));
    // 1 market tick
    pipeline.bus.emit('event', {
      type: 'market',
      payload: { instrument: 'NQH4', price: 18200, timestamp: new Date().toISOString() },
    } satisfies BrokerEvent);

    // Lock the account and send one more — should be rejected
    pipeline.accountEngine.getAccount('TRD-INT')!.locked = true;
    pipeline.bus.emit('event', execEvent({ execution_id: 'u4' }));

    const stats = pipeline.ingester.getStats();
    expect(stats.duplicates).toBe(1);
    expect(stats.rejected).toBe(1);
    // processed = 3 unique execs + 1 market tick (locked exec is rejected, not processed)
    expect(stats.processed).toBe(4);
  });
});
