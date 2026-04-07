import { AccountStateEngine } from '../../src/problem1/engine/AccountStateEngine';
import type { ExecutionEvent, MarketPriceFeed } from '../../src/common/types';

function makeExecution(overrides: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    broker: 'Broker_A',
    account_id: 'TRD-TEST',
    instrument: 'NQH4',
    side: 'BUY',
    qty: 2,
    price: 18200,
    timestamp: new Date().toISOString(),
    execution_id: 'exec-001',
    ...overrides,
  };
}

describe('AccountStateEngine', () => {
  let engine: AccountStateEngine;

  beforeEach(() => {
    engine = new AccountStateEngine();
  });

  describe('position tracking', () => {
    it('opens a new long position on BUY', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 3, price: 18200 }));
      const state = engine.getAccount('TRD-TEST')!;
      expect(state.positions['NQH4']?.position_qty).toBe(3);
      expect(state.positions['NQH4']?.avg_price).toBe(18200);
    });

    it('increases avg price when adding to long', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 2, price: 18200, execution_id: 'e1' }));
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 2, price: 18300, execution_id: 'e2' }));
      const pos = engine.getAccount('TRD-TEST')!.positions['NQH4']!;
      expect(pos.position_qty).toBe(4);
      expect(pos.avg_price).toBe(18250);
    });

    it('reduces position on SELL and realizes PnL', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 4, price: 18200, execution_id: 'e1' }));
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 2, price: 18300, execution_id: 'e2' }));
      const state = engine.getAccount('TRD-TEST')!;
      expect(state.positions['NQH4']?.position_qty).toBe(2);
      // Realized: 2 * (18300 - 18200) * 20 = 4000
      expect(state.realized_pnl).toBeCloseTo(4000);
    });

    it('flips position from long to short', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 2, price: 18200, execution_id: 'e1' }));
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 5, price: 18300, execution_id: 'e2' }));
      const pos = engine.getAccount('TRD-TEST')!.positions['NQH4']!;
      expect(pos.position_qty).toBe(-3);
      expect(pos.avg_price).toBe(18300);
    });

    it('closes position to zero', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 2, price: 18200, execution_id: 'e1' }));
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 2, price: 18300, execution_id: 'e2' }));
      const pos = engine.getAccount('TRD-TEST')!.positions['NQH4']!;
      expect(pos.position_qty).toBe(0);
      expect(pos.avg_price).toBe(0);
    });

    it('opens a short position on SELL from flat', () => {
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 3, price: 18200, execution_id: 'e1' }));
      const pos = engine.getAccount('TRD-TEST')!.positions['NQH4']!;
      expect(pos.position_qty).toBe(-3);
      expect(pos.avg_price).toBe(18200);
    });
  });

  describe('unrealized PnL', () => {
    it('updates unrealized PnL on market price tick', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 2, price: 18200, execution_id: 'e1' }));
      const feed: MarketPriceFeed = { instrument: 'NQH4', price: 18250, timestamp: new Date().toISOString() };
      engine.handleMarketPrice(feed);
      // 2 * (18250 - 18200) * 20 = 2000
      expect(engine.getAccount('TRD-TEST')!.unrealized_pnl).toBeCloseTo(2000);
    });

    it('negative unrealized for adverse price move', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 1, price: 18200, execution_id: 'e1' }));
      engine.handleMarketPrice({ instrument: 'NQH4', price: 18150, timestamp: new Date().toISOString() });
      // 1 * (18150 - 18200) * 20 = -1000
      expect(engine.getAccount('TRD-TEST')!.unrealized_pnl).toBeCloseTo(-1000);
    });

    it('does not update unrealized PnL for unrelated instrument', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 1, price: 18200, execution_id: 'e1' }));
      engine.handleMarketPrice({ instrument: 'ESM4', price: 5300, timestamp: new Date().toISOString() });
      expect(engine.getAccount('TRD-TEST')!.unrealized_pnl).toBe(0);
    });
  });

  describe('trade statistics', () => {
    it('tracks win rate', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 1, price: 18200, execution_id: 'e1' }));
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 1, price: 18300, execution_id: 'e2' }));
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 1, price: 18300, execution_id: 'e3' }));
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 1, price: 18200, execution_id: 'e4' }));

      const state = engine.getAccount('TRD-TEST')!;
      expect(state.trade_count).toBe(2);
      expect(state.winning_trades).toBe(1);
      expect(state.win_rate).toBe(0.5);
    });
  });

  describe('locked account', () => {
    it('rejects executions when account is locked', () => {
      engine.handleExecution(makeExecution({ execution_id: 'e1' }));
      const state = engine.getAccount('TRD-TEST')!;
      state.locked = true;

      const accepted = engine.handleExecution(makeExecution({ execution_id: 'e2' }));
      expect(accepted).toBe(false);
      // Position unchanged from first trade
      expect(state.positions['NQH4']?.position_qty).toBe(2);
    });

    it('unlockAccount clears the lock', () => {
      const state = engine.getAccount('TRD-TEST') ?? (engine.handleExecution(makeExecution()), engine.getAccount('TRD-TEST')!);
      state.locked = true;
      engine.unlockAccount('TRD-TEST');
      expect(engine.getAccount('TRD-TEST')!.locked).toBe(false);
    });
  });

  describe('daily reset', () => {
    it('resets all daily fields to zero', () => {
      engine.handleExecution(makeExecution({ side: 'BUY', qty: 1, price: 18200, execution_id: 'e1' }));
      engine.handleExecution(makeExecution({ side: 'SELL', qty: 1, price: 18300, execution_id: 'e2' }));
      const state = engine.getAccount('TRD-TEST')!;
      state.locked = true;
      expect(state.realized_pnl).toBeGreaterThan(0);

      engine.resetDaily();

      expect(state.realized_pnl).toBe(0);
      expect(state.daily_pnl).toBe(0);
      expect(state.peak_daily_pnl).toBe(0);
      expect(state.trade_count).toBe(0);
      expect(state.locked).toBe(false);
      expect(state.risk_status).toBe('OK');
    });
  });

  describe('snapshot serialisation', () => {
    it('emits update event on execution', (done) => {
      engine.on('update', (snapshot) => {
        expect(snapshot.account_id).toBe('TRD-TEST');
        done();
      });
      engine.handleExecution(makeExecution());
    });

    it('snapshot includes locked field', () => {
      engine.handleExecution(makeExecution());
      const state = engine.getAccount('TRD-TEST')!;
      const snap = engine.toSnapshot(state);
      expect(snap.locked).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for execution on unknown account when locked externally', () => {
      // Create account then lock it
      engine.handleExecution(makeExecution({ execution_id: 'setup' }));
      engine.getAccount('TRD-TEST')!.locked = true;
      const result = engine.handleExecution(makeExecution({ execution_id: 'rejected' }));
      expect(result).toBe(false);
    });

    it('handles market price tick with no accounts gracefully', () => {
      expect(() =>
        engine.handleMarketPrice({ instrument: 'NQH4', price: 18200, timestamp: new Date().toISOString() }),
      ).not.toThrow();
    });

    it('unlockAccount returns false for non-existent account', () => {
      expect(engine.unlockAccount('UNKNOWN')).toBe(false);
    });
  });
});
