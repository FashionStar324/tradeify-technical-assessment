import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import type { BrokerEvent, ExecutionEvent, MarketPriceFeed, Side } from '../../common/types';

/** Mid prices per instrument — updated by market simulator */
const marketPrices: Record<string, number> = {
  NQH4: 18200,
  ESM4: 5200,
  NQM4: 18210,
  ESH4: 5195,
};

/**
 * Simulates a single broker's execution event stream.
 *
 * Mean-reversion bias: when an account already has a large position in one
 * direction, the simulator prefers the opposite side, keeping positions
 * realistic rather than growing unboundedly.
 */
export class BrokerSimulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Monotonically increasing sequence number per account */
  private readonly seqMap = new Map<string, number>();

  constructor(
    private readonly broker: string,
    private readonly bus: EventEmitter,
    /** Approximate net position per account (used for mean-reversion bias) */
    private readonly netPositions: Map<string, number>,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.emitEvent(), config.simulator.eventIntervalMs);
    logger.info(`[BrokerSimulator] ${this.broker} started`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private emitEvent(): void {
    const instrument = randomPick(config.simulator.instruments);
    const account_id = randomPick(config.simulator.accounts);
    const side = this.chooseSide(account_id);
    const qty = randomInt(1, config.risk.maxContractsPerTrade);
    const midPrice = marketPrices[instrument] ?? 1000;
    const slippage = (Math.random() - 0.5) * 2; // ±1 tick slippage
    const price = parseFloat((midPrice + slippage).toFixed(2));

    // Update approximate position for mean-reversion
    const delta = side === 'BUY' ? qty : -qty;
    this.netPositions.set(account_id, (this.netPositions.get(account_id) ?? 0) + delta);

    const seq = (this.seqMap.get(account_id) ?? 0) + 1;
    this.seqMap.set(account_id, seq);

    const event: ExecutionEvent = {
      broker: this.broker,
      account_id,
      instrument,
      side,
      qty,
      price,
      timestamp: new Date().toISOString(),
      execution_id: uuidv4(),
      seq,
    };

    this.bus.emit('event', { type: 'execution', payload: event } satisfies BrokerEvent);

    // Simulate duplicate (≈5% of events)
    if (Math.random() < 0.05) {
      setTimeout(
        () => this.bus.emit('event', { type: 'execution', payload: { ...event } } satisfies BrokerEvent),
        randomInt(10, 200),
      );
    }

    // Simulate out-of-order event (≈3% of events)
    if (Math.random() < 0.03) {
      const staleTs = new Date(Date.now() - randomInt(500, 3000)).toISOString();
      const staleEvent: BrokerEvent = {
        type: 'execution',
        payload: { ...event, execution_id: uuidv4(), timestamp: staleTs, seq: seq - 1 },
      };
      setTimeout(() => this.bus.emit('event', staleEvent), randomInt(100, 800));
    }
  }

  /**
   * Picks BUY or SELL using mean-reversion bias.
   * The stronger the existing position in one direction, the more likely
   * the simulator trades against it.
   */
  private chooseSide(accountId: string): Side {
    const net = this.netPositions.get(accountId) ?? 0;
    const strength = config.simulator.meanReversionStrength;

    // Base probability of BUY
    // net > 0 (long) → biased toward SELL; net < 0 (short) → biased toward BUY
    const maxBias = strength * 0.5; // max shift from 0.5 base probability
    const bias = -Math.tanh(net / config.risk.maxPositionSize) * maxBias;
    const pBuy = 0.5 + bias;

    return Math.random() < pBuy ? 'BUY' : 'SELL';
  }
}

/**
 * Emits periodic market price ticks for all instruments.
 */
export class MarketPriceSimulator {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly bus: EventEmitter) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), config.simulator.priceTickIntervalMs);
    logger.info('[MarketPriceSimulator] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getPrices(): Readonly<Record<string, number>> {
    return { ...marketPrices };
  }

  private tick(): void {
    for (const instrument of config.simulator.instruments) {
      const current = marketPrices[instrument] ?? 1000;
      marketPrices[instrument] = parseFloat((current + (Math.random() - 0.5)).toFixed(2));

      const feed: MarketPriceFeed = {
        instrument,
        price: marketPrices[instrument],
        timestamp: new Date().toISOString(),
      };
      this.bus.emit('event', { type: 'market', payload: feed } satisfies BrokerEvent);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
