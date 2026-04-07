export const config = {
  server: {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
  },

  risk: {
    maxDailyLoss: -2500,       // USD — account is violated if daily_pnl drops below this
    maxPositionSize: 10,       // contracts — absolute net position across all instruments
    maxContractsPerTrade: 5,   // contracts per single execution
    trailingDrawdown: 3000,    // USD — violation when (peak_daily_pnl - current_daily_pnl) >= this
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
  },

  /** Point value (dollars per 1-point move) per contract */
  contractMultipliers: {
    NQ: 20,
    ES: 50,
    MNQ: 2,
    MES: 5,
  } as Record<string, number>,
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
