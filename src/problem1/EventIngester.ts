import { EventEmitter } from 'events';
import { logger } from '../common/logger';
import { AccountStateEngine } from './engine/AccountStateEngine';
import { EventDeduplicator } from './engine/EventDeduplicator';
import { RiskRuleEngine } from './engine/RiskRuleEngine';
import type { BrokerEvent } from '../common/types';

/**
 * Central event ingester — subscribes to the shared broker event bus,
 * deduplicates execution events, routes them to the AccountStateEngine,
 * and triggers risk evaluation after every state mutation.
 *
 * Out-of-order detection: sequence numbers from the broker are tracked per
 * (broker, account_id). A gap or regression in the sequence is logged as a
 * warning. Events are still processed (idempotency is guaranteed by
 * execution_id dedup) — full causal ordering would require a persistent
 * event log partitioned by account_id.
 */
export class EventIngester {
  private readonly dedup = new EventDeduplicator();
  /** broker:account_id → last seen seq */
  private readonly seqTracker = new Map<string, number>();
  private stats = { received: 0, duplicates: 0, outOfOrder: 0, rejected: 0, processed: 0 };

  // Stored so we can remove exactly this listener in stop() without
  // accidentally clearing other components' handlers on the same bus.
  private readonly busHandler = (event: BrokerEvent) => this.handle(event);

  constructor(
    private readonly bus: EventEmitter,
    private readonly accountEngine: AccountStateEngine,
    private readonly riskEngine: RiskRuleEngine,
  ) {}

  start(): void {
    this.bus.on('event', this.busHandler);
    logger.info('[EventIngester] Listening for broker events');
  }

  stop(): void {
    this.bus.off('event', this.busHandler);
    this.dedup.stop();
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  private handle(event: BrokerEvent): void {
    this.stats.received++;

    switch (event.type) {
      case 'execution': {
        const { payload } = event;

        if (!this.dedup.isNew(payload.execution_id)) {
          this.stats.duplicates++;
          logger.debug(`[EventIngester] Duplicate ignored: ${payload.execution_id}`);
          return;
        }

        this.checkSequence(payload.broker, payload.account_id, payload.seq);

        const accepted = this.accountEngine.handleExecution(payload);
        if (!accepted) {
          this.stats.rejected++;
          return;
        }

        const state = this.accountEngine.getAccount(payload.account_id);
        if (state) this.riskEngine.evaluate(state, payload);

        this.stats.processed++;
        break;
      }

      case 'position': {
        this.accountEngine.handlePositionUpdate(event.payload);
        const state = this.accountEngine.getAccount(event.payload.account_id);
        if (state) this.riskEngine.evaluate(state);
        this.stats.processed++;
        break;
      }

      case 'market': {
        this.accountEngine.handleMarketPrice(event.payload);
        for (const state of this.accountEngine.getAllAccounts()) {
          this.riskEngine.evaluate(state);
        }
        this.stats.processed++;
        break;
      }
    }
  }

  private checkSequence(broker: string, accountId: string, seq?: number): void {
    if (seq === undefined) return;
    const key = `${broker}:${accountId}`;
    const last = this.seqTracker.get(key);

    if (last !== undefined && seq <= last) {
      this.stats.outOfOrder++;
      logger.warn(
        `[EventIngester] Out-of-order event from ${broker} for ${accountId}: ` +
        `expected >${last}, got ${seq}`,
      );
    } else if (last !== undefined && seq > last + 1) {
      logger.warn(
        `[EventIngester] Sequence gap from ${broker} for ${accountId}: ` +
        `last=${last}, received=${seq} (missed ${seq - last - 1} events)`,
      );
    }

    this.seqTracker.set(key, seq);
  }
}
