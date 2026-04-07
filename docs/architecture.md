# Architecture Notes

## Problem 1 — Real-Time Multi-Broker Trading Dashboard

### Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  BrokerSimulator × 3        MarketPriceSimulator                │
│  (Broker_A / B / C)         (NQH4, ESM4, …)                    │
└──────────────┬──────────────────────┬──────────────────────────┘
               │ BrokerEvent          │ MarketPriceFeed
               ▼                      ▼
         ┌─────────────────────────────┐
         │       EventEmitter bus      │  (in-process, non-blocking)
         └──────────────┬──────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │  EventIngester   │  deduplication, routing
              └───────┬──────────┘
                      │
           ┌──────────┴──────────┐
           ▼                     ▼
  ┌─────────────────┐   ┌─────────────────┐
  │ AccountState    │   │  RiskRule        │
  │ Engine          │──▶│  Engine          │
  └────────┬────────┘   └────────┬────────┘
           │                     │ violation events
           │ update events        │
           ▼                     ▼
    ┌────────────────┐    stderr / logger
    │ DashboardFeed  │
    │ (WebSocket)    │
    └────────────────┘
```

### Key Design Decisions

**Event Bus (EventEmitter)**
A Node.js `EventEmitter` acts as the in-process event bus. This is appropriate for a single-node deployment and allows zero-copy event delivery between broker simulators and consumers. For a horizontally scaled deployment, this would be replaced with Redis Streams or Kafka.

**Concurrent Event Streams**
Each broker runs an independent `setInterval` loop. Because Node.js is single-threaded, events are serialised through the event loop — no mutex is needed. For CPU-bound event processing at very high throughput, Worker Threads or a separate process per broker would be used.

**Deduplication (EventDeduplicator)**
Execution IDs are stored in a time-bounded `Map<string, timestamp>`. Entries older than 60 seconds are evicted on a periodic timer. This bounds memory to roughly `events/sec × 60s` unique IDs, which is manageable even at high throughput. A Redis SET with TTL would be the production equivalent.

**Out-of-Order Events**
Events carry ISO 8601 timestamps from the originating broker. The ingester processes events as they arrive — we do not buffer and reorder because:
1. We use `execution_id` dedup, so late duplicates are harmless.
2. Average-cost accounting is commutative for fills that don't cross zero (order doesn't affect the final average). Fills that cross zero can produce slightly different intermediate states, but the correct final position is always reached once all fills for a round-trip are processed.
3. For a production system requiring strict ordering, events would be written to an append-only log (Kafka topic partitioned by `account_id`) and consumed in-order from the log.

**Average-Cost PnL Accounting**
We use the average-cost method rather than FIFO/LIFO:
- Simpler to implement correctly
- Appropriate for prop-firm accounts where positions are managed as a whole
- Widely used in retail and prop trading platforms

**Position Flip Handling**
When a fill crosses zero (e.g., long 2, sell 5 → short 3):
1. Close 2 contracts at fill price → realise PnL
2. Open 3 contracts in the opposite direction at fill price
This is the correct treatment and matches how most brokerages report PnL.

**Risk Engine**
The `RiskRuleEngine` is stateless — it receives the current `AccountState` and an optional incoming execution. This makes it trivially testable and replaceable. Rules are evaluated synchronously after every state mutation, ensuring zero-latency violation detection.

**Trailing Drawdown**
Implemented as: `violation if (peak_daily_pnl - daily_pnl) >= 3000`.
`peak_daily_pnl` is a high-water mark updated whenever `daily_pnl` exceeds it. This matches the prop-firm standard definition.

**Dashboard WebSocket Feed**
Clients connect to `ws://host/ws` and send a subscription message:
```json
{ "subscribe": ["TRD-44821"] }
// or
{ "subscribe": "ALL" }
```
The server pushes `AccountSnapshot` objects immediately on every state change. There is no debounce by design — the assessment asks for immediate updates. In production, a 50–100ms debounce per account would prevent redundant renders under burst conditions.

### Reliability Scenarios

| Scenario | Handling |
|---|---|
| Duplicate executions | `EventDeduplicator` — O(1) lookup, TTL-based eviction |
| Out-of-order events | Idempotent processing; late fills produce same final state |
| Network latency | WebSocket with auto-reconnect; broker event timestamped at source |
| Broker event bursts | Node.js event loop queues naturally absorb bursts; EventEmitter is non-blocking |
| Account reconnections | Stateless snapshot protocol — client re-subscribes after reconnect, server pushes full current state |

---

## Problem 2 — Brokerage Outage Remediation Engine

### Overview

```
Input:  TradeRecord[]   AccountBalance[]
           │                  │
           ▼                  ▼
   ┌────────────────────────────┐
   │     RemediationEngine      │
   │                            │
   │  1. Identify impacted      │
   │     trades (window filter) │
   │                            │
   │  2. Calculate PnL per      │
   │     trade                  │
   │                            │
   │  3. For losing trades:     │
   │     a. Write audit entry   │  ← WAL pattern
   │     b. Adjust balance      │
   │     c. Mark remediated     │
   └───────────┬────────────────┘
               │
               ▼
        ┌──────────────┐
        │  AuditLogger │  (append-only in-memory log)
        └──────────────┘
               │
               ▼
   ┌────────────────────────────┐
   │  ReconciliationEngine      │
   │  Compare internal vs       │
   │  broker-authoritative      │
   │  balances                  │
   └────────────────────────────┘
```

### Key Design Decisions

**Idempotency**
Each `TradeRecord` carries a `remediated: boolean` and `remediation_run_id` field. Before processing, the engine checks this flag. If already set, the trade is skipped with an audit log entry. This ensures reruns are safe and produce a deterministic no-op for already-processed trades.

**Write-Ahead Log (WAL) Pattern**
The audit entry is written _before_ the balance is mutated. This mirrors the WAL pattern used in databases — if the process crashes mid-remediation, the audit log shows what was intended, and a recovery process can complete or roll back the mutation on restart.

**Outage Window Logic**
A trade is considered impacted if _either_ its `entry_time` or `exit_time` falls within `[windowStart, windowEnd)`. The window end is exclusive to avoid ambiguity at the boundary. This matches the assessment description ("either entry or exit occurred during the outage window").

**PnL Formula**
```
PnL = (exit_price - entry_price) × qty × contract_multiplier
```
Positive PnL = profitable (leave untouched).
Negative PnL = losing (remediate → restore balance by `-PnL`).

**Contract Multiplier Resolution**
Instrument symbols like `NQH4` or `ESM4` have a variable-length alphabetic prefix (`NQ`, `ES`). We sort known multipliers by key length descending and find the first prefix match. This handles both `NQ` and `MNQ` correctly without ambiguity.

**Dry-Run Mode**
The engine accepts a `dryRun` flag. In dry-run mode, all PnL calculations and audit logging proceed normally, but balance mutations and trade-marking are skipped. This allows operators to preview the impact of a remediation before executing.

**Reconciliation**
After remediation, `ReconciliationEngine.reconcile()` compares internal balances against broker-reported balances (simulated here; in production fetched via broker API). Discrepancies larger than $0.01 (floating-point tolerance) are logged as `MISMATCH`. This surfaces any accounting errors that slipped through.

### Data Integrity Guarantees

| Requirement | Implementation |
|---|---|
| Idempotent reruns | `trade.remediated` flag checked before processing |
| No double remediation | Same flag — second run sees `remediated=true`, skips |
| Full audit logs | `AuditLogger` records every action with run_id, timestamp, before/after values |
| Determinism | Same input → same output; no randomness in remediation logic |

### Optional Enhancements (not implemented but architected for)

- **Kafka / Redis Streams** — replace EventEmitter bus with a persistent, replayable event log partitioned by `account_id`
- **Replayable event log** — store all broker events with sequence numbers; allow full account state reconstruction from offset 0
- **Reconciliation diff engine** — structured diff with per-field comparison and automatic discrepancy filing
- **Distributed scaling** — partition accounts across nodes; each node owns a shard of accounts and runs its own risk engine instance
