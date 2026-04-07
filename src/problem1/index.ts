/**
 * Problem 1 bootstrap — wires up all components and starts the simulator.
 * Used when running `npm run dev:p1` standalone (no HTTP server).
 */
import { EventEmitter } from 'events';
import { config } from '../common/config';
import { logger } from '../common/logger';
import { BrokerSimulator, MarketPriceSimulator } from './broker/BrokerSimulator';
import { AccountStateEngine } from './engine/AccountStateEngine';
import { RiskRuleEngine } from './engine/RiskRuleEngine';
import { EventIngester } from './EventIngester';

export function createProblem1(bus: EventEmitter = new EventEmitter()) {
  const accountEngine = new AccountStateEngine();
  const riskEngine = new RiskRuleEngine();
  const ingester = new EventIngester(bus, accountEngine, riskEngine);

  const brokerSims = config.simulator.brokers.map(
    (broker) => new BrokerSimulator(broker, bus),
  );
  const marketSim = new MarketPriceSimulator(bus);

  function start(): void {
    ingester.start();
    brokerSims.forEach((s) => s.start());
    marketSim.start();
    logger.info('[Problem1] All simulators started');
  }

  function stop(): void {
    brokerSims.forEach((s) => s.stop());
    marketSim.stop();
    ingester.stop();
    logger.info('[Problem1] Stopped');
  }

  return { accountEngine, riskEngine, ingester, start, stop };
}

// Run standalone
if (require.main === module) {
  const p1 = createProblem1();

  p1.accountEngine.on('update', (snapshot) => {
    logger.info(`[Dashboard] ${snapshot.account_id} | PnL: ${snapshot.daily_pnl} | Pos: ${snapshot.total_net_position} | Risk: ${snapshot.risk_status}`);
  });

  p1.riskEngine.on('violation', (msg: string) => {
    logger.warn(`[RISK ALERT] ${msg}`);
  });

  p1.start();

  // Print stats every 10s
  setInterval(() => {
    const stats = p1.ingester.getStats();
    logger.info(`[Stats] received=${stats.received} duplicates=${stats.duplicates} processed=${stats.processed}`);
  }, 10_000);

  process.on('SIGINT', () => {
    p1.stop();
    process.exit(0);
  });
}
