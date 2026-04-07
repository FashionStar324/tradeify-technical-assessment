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

  /** Shared approximate positions for mean-reversion bias across all brokers */
  const netPositions = new Map<string, number>();

  // MarketPriceSimulator owns the price book. BrokerSimulators receive the
  // live reference so their fills always reflect the latest mid prices without
  // copying. Create marketSim first so the reference is available.
  const marketSim = new MarketPriceSimulator(bus);
  const brokerSims = config.simulator.brokers.map(
    (broker) => new BrokerSimulator(broker, bus, netPositions, marketSim.prices),
  );
  let dailyResetTimer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    ingester.start();
    brokerSims.forEach((s) => s.start());
    marketSim.start();
    scheduleDailyReset();
    logger.info('[Problem1] All simulators started');
  }

  function stop(): void {
    brokerSims.forEach((s) => s.stop());
    marketSim.stop();
    ingester.stop();
    if (dailyResetTimer) clearInterval(dailyResetTimer);
    logger.info('[Problem1] Stopped');
  }

  /**
   * Schedules a daily PnL reset at the configured market-close UTC time.
   * Checks every minute whether it's time to reset.
   */
  function scheduleDailyReset(): void {
    const [closeHour, closeMin] = config.marketCloseUtc.split(':').map(Number);
    dailyResetTimer = setInterval(() => {
      const now = new Date();
      if (now.getUTCHours() === closeHour && now.getUTCMinutes() === closeMin) {
        accountEngine.resetDaily();
      }
    }, 60_000);
    if (dailyResetTimer.unref) dailyResetTimer.unref();
  }

  return { accountEngine, riskEngine, ingester, start, stop };
}

// Run standalone
if (require.main === module) {
  const p1 = createProblem1();

  p1.accountEngine.on('update', (snapshot) => {
    logger.info(
      `[Dashboard] ${snapshot.account_id} | PnL: ${snapshot.daily_pnl} | ` +
      `Pos: ${snapshot.total_net_position} | Risk: ${snapshot.risk_status}` +
      (snapshot.locked ? ' | LOCKED' : ''),
    );
  });

  p1.riskEngine.on('violation', (msg: string) => {
    logger.warn(`[RISK ALERT] ${msg}`);
  });

  p1.start();

  setInterval(() => {
    const stats = p1.ingester.getStats();
    logger.info(
      `[Stats] received=${stats.received} duplicates=${stats.duplicates} ` +
      `outOfOrder=${stats.outOfOrder} rejected=${stats.rejected} processed=${stats.processed}`,
    );
  }, 10_000);

  process.on('SIGINT', () => {
    p1.stop();
    process.exit(0);
  });
}
