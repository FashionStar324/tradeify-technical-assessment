import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import type { BrokerEvent, ExecutionEvent, MarketPriceFeed } from '../../common/types';

/** Mid prices per instrument — updated by market simulator */
const marketPrices: Record<string, number> = {
  NQH4: 18200,
  ESM4: 5200,
  NQM4: 18210,
  ESH4: 5195,
};

/**
 * Simulates a single broker's execution event stream.
 * Emits `BrokerEvent` objects on the shared event bus.
 */
export class BrokerSimulator {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly broker: string,
    private readonly bus: EventEmitter,
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
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const qty = randomInt(1, config.risk.maxContractsPerTrade);
    const midPrice = marketPrices[instrument] ?? 1000;
    const slippage = (Math.random() - 0.5) * 2; // ±1 tick slippage
    const price = parseFloat((midPrice + slippage).toFixed(2));

    const event: ExecutionEvent = {
      broker: this.broker,
      account_id,
      instrument,
      side,
      qty,
      price,
      timestamp: new Date().toISOString(),
      execution_id: uuidv4(),
    };

    const brokerEvent: BrokerEvent = { type: 'execution', payload: event };
    this.bus.emit('event', brokerEvent);

    // Occasionally simulate a duplicate (≈5% of events)
    if (Math.random() < 0.05) {
      setTimeout(
        () => this.bus.emit('event', { type: 'execution', payload: { ...event } }),
        randomInt(10, 200),
      );
    }

    // Occasionally emit an out-of-order event (≈3% of events) with a stale timestamp
    if (Math.random() < 0.03) {
      const staleTs = new Date(Date.now() - randomInt(500, 3000)).toISOString();
      const staleEvent: BrokerEvent = {
        type: 'execution',
        payload: { ...event, execution_id: uuidv4(), timestamp: staleTs },
      };
      setTimeout(() => this.bus.emit('event', staleEvent), randomInt(100, 800));
    }
  }
}

/**
 * Emits periodic market price ticks for all instruments on the shared bus.
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

  /** Returns a read-only snapshot of current prices */
  getPrices(): Readonly<Record<string, number>> {
    return { ...marketPrices };
  }

  private tick(): void {
    for (const instrument of config.simulator.instruments) {
      const current = marketPrices[instrument] ?? 1000;
      // Random walk: ±0.5 per tick
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
