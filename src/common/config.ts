export const config = {
  server: {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
  },

  risk: {
    maxDailyLoss: -2500,       // USD — VIOLATED if daily_pnl drops at or below this
    maxPositionSize: 10,       // contracts — absolute net position across all instruments
    maxContractsPerTrade: 5,   // contracts per single execution
    trailingDrawdown: 3000,    // USD — VIOLATED when (peak_daily_pnl - daily_pnl) >= this
    /** Fraction of each limit at which WARNING is raised (0.8 = 80%) */
    warningThresholdRatio: 0.8,
  },

  simulator: {
    brokers: ['Broker_A', 'Broker_B', 'Broker_C'] as const,
    instruments: ['NQH4', 'ESM4', 'NQM4', 'ESH4'] as const,
    accounts: [
      'TRD-44821', 'TRD-88312', 'TRD-55901', 'TRD-22401', 'TRD-67734',
    ] as const,
    /** How often each broker emits an event (ms) */
    eventIntervalMs: 400,
    /** Market price tick interval (ms) */
    priceTickIntervalMs: 500,
    /**
     * Mean-reversion strength [0–1].
     * At 0: fully random BUY/SELL.
     * At 1: always trades toward flat.
     * 0.65 gives realistic oscillation while still generating violations.
     */
    meanReversionStrength: 0.65,
  },

  /** Point value (dollars per 1-point move) per contract */
  contractMultipliers: {
    NQ: 20,
    ES: 50,
    MNQ: 2,
    MES: 5,
  } as Record<string, number>,

  /** Market-close time in UTC for daily PnL reset (HH:MM) */
  marketCloseUtc: '21:00',
} as const;

/** Resolve the multiplier from an instrument symbol like "NQH4" or "ESM4" */
export function getContractMultiplier(instrument: string): number {
  const prefix = instrument.replace(/[^A-Z]/g, '').replace(/\d/g, '');
  // Try longest match first (MNQ before NQ)
  const sorted = Object.entries(config.contractMultipliers).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [key, value] of sorted) {
    if (prefix.startsWith(key)) return value;
  }
  return 1; // unknown instrument — no multiplier
}
