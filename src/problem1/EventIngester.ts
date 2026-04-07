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
 * Out-of-order handling: events carry an ISO timestamp. If an execution
 * event arrives with a timestamp older than the account's last_updated,
 * we still process it (idempotency is guaranteed by execution_id dedup)
 * but log a warning. Full replay-based ordering would require a
 * persistent event log (see architecture notes).
 */
export class EventIngester {
  private readonly dedup = new EventDeduplicator();
  private stats = { received: 0, duplicates: 0, processed: 0 };

  constructor(
    private readonly bus: EventEmitter,
    private readonly accountEngine: AccountStateEngine,
    private readonly riskEngine: RiskRuleEngine,
  ) {}

  start(): void {
    this.bus.on('event', (event: BrokerEvent) => this.handle(event));
    logger.info('[EventIngester] Listening for broker events');
  }

  stop(): void {
    this.bus.removeAllListeners('event');
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
          logger.debug(
            `[EventIngester] Duplicate execution ignored: ${payload.execution_id}`,
          );
          return;
        }

        this.accountEngine.handleExecution(payload);

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
        // Re-evaluate all accounts on price change (unrealized PnL changes)
        for (const state of this.accountEngine.getAllAccounts()) {
          this.riskEngine.evaluate(state);
        }
        this.stats.processed++;
        break;
      }
    }
  }
}
