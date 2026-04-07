import { calculateTradePnL, isInOutageWindow } from '../../src/problem2/PnLCalculator';
import type { TradeRecord } from '../../src/common/types';

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 'T-001',
    account_id: 'TRD-TEST',
    instrument: 'ESM4',
    entry_price: 5200,
    exit_price: 5205,
    qty: 2,
    entry_time: '2026-03-10T14:32:00.000Z',
    exit_time: '2026-03-10T14:35:00.000Z',
    ...overrides,
  };
}

const OUTAGE_START = '2026-03-10T14:30:00.000Z';
const OUTAGE_END = '2026-03-10T14:48:00.000Z';

describe('calculateTradePnL', () => {
  it('calculates profitable ES trade correctly', () => {
    const trade = makeTrade({ entry_price: 5200, exit_price: 5205, qty: 2, instrument: 'ESM4' });
    // PnL = (5205 - 5200) * 2 * 50 = 500
    expect(calculateTradePnL(trade)).toBe(500);
  });

  it('calculates losing ES trade correctly', () => {
    const trade = makeTrade({ entry_price: 5205, exit_price: 5200, qty: 2, instrument: 'ESM4' });
    // PnL = (5200 - 5205) * 2 * 50 = -500
    expect(calculateTradePnL(trade)).toBe(-500);
  });

  it('calculates NQ trade with multiplier 20', () => {
    const trade = makeTrade({ entry_price: 18200, exit_price: 18210, qty: 1, instrument: 'NQH4' });
    // PnL = (18210 - 18200) * 1 * 20 = 200
    expect(calculateTradePnL(trade)).toBe(200);
  });

  it('uses the assessment example: ESM4 T-883721', () => {
    const trade = makeTrade({ entry_price: 5201.25, exit_price: 5198.00, qty: 2, instrument: 'ESM4' });
    // PnL = (5198.00 - 5201.25) * 2 * 50 = -325
    expect(calculateTradePnL(trade)).toBeCloseTo(-325);
  });
});

describe('isInOutageWindow', () => {
  it('returns true when both times are inside window', () => {
    const trade = makeTrade({
      entry_time: '2026-03-10T14:32:00.000Z',
      exit_time: '2026-03-10T14:40:00.000Z',
    });
    expect(isInOutageWindow(trade, OUTAGE_START, OUTAGE_END)).toBe(true);
  });

  it('returns true when only entry is inside window', () => {
    const trade = makeTrade({
      entry_time: '2026-03-10T14:35:00.000Z',
      exit_time: '2026-03-10T15:00:00.000Z',
    });
    expect(isInOutageWindow(trade, OUTAGE_START, OUTAGE_END)).toBe(true);
  });

  it('returns true when only exit is inside window', () => {
    const trade = makeTrade({
      entry_time: '2026-03-10T14:25:00.000Z',
      exit_time: '2026-03-10T14:35:00.000Z',
    });
    expect(isInOutageWindow(trade, OUTAGE_START, OUTAGE_END)).toBe(true);
  });

  it('returns false when trade is entirely outside window', () => {
    const trade = makeTrade({
      entry_time: '2026-03-10T15:00:00.000Z',
      exit_time: '2026-03-10T15:10:00.000Z',
    });
    expect(isInOutageWindow(trade, OUTAGE_START, OUTAGE_END)).toBe(false);
  });

  it('returns false for trade before window', () => {
    const trade = makeTrade({
      entry_time: '2026-03-10T14:00:00.000Z',
      exit_time: '2026-03-10T14:20:00.000Z',
    });
    expect(isInOutageWindow(trade, OUTAGE_START, OUTAGE_END)).toBe(false);
  });

  it('returns false at exact window end boundary (exclusive)', () => {
    const trade = makeTrade({
      entry_time: '2026-03-10T14:48:00.000Z',
      exit_time: '2026-03-10T14:50:00.000Z',
    });
    expect(isInOutageWindow(trade, OUTAGE_START, OUTAGE_END)).toBe(false);
  });
});
