# Architecture Notes

## Problem 1 — Real-Time Multi-Broker Trading Dashboard

### Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  BrokerSimulator × 3            MarketPriceSimulator                 │
│  (Broker_A / B / C)             (NQH4, ESM4, NQM4, ESH4)            │
│  • mean-reversion bias          • random walk price ticks            │
│  • per-broker sequence numbers  • 500ms interval                     │
│  • duplicate / OOO simulation   │                                    │
└──────────────┬──────────────────────────┬───────────────────────────┘
               │ ExecutionEvent           │ MarketPriceFeed
               │ (seq, execution_id)      │
               ▼                          ▼
         ┌──────────────────────────────────┐
         │         EventEmitter bus         │  (in-process, non-blocking)
         └─────────────────┬────────────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │     EventIngester     │
               │  • dedup by exec_id   │
               │  • seq gap detection  │
               │  • locked acct reject │
               └──────────┬────────────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
  ┌──────────────────────┐   ┌──────────────────────┐
  │  AccountStateEngine  │──▶│   RiskRuleEngine      │
  │  • avg-cost PnL      │   │  • OK / WARNING /     │
  │  • position tracking │   │    VIOLATED           │
  │  • locked flag       │   │  • 80% warning thresh │
  │  • daily reset       │   │  • auto-clear on      │
  └──────────┬───────────┘   │    recovery           │
             │               │  • lock on critical   │
             │ update events │    violations         │
             ▼               └──────────┬────────────┘
  ┌──────────────────────┐              │ violation events
  │    DashboardFeed     │              ▼
  │  • 50ms debounce     │         logger / alerts
  │  • snapshot on sub   │
  │  • ping/pong cleanup │
  │  • zod msg validate  │
  └──────────────────────┘
         ▲
         │ WebSocket /ws
    connected clients
```

### Key Design Decisions

**Event Bus (EventEmitter)**
A Node.js `EventEmitter` acts as the in-process event bus. This is appropriate for a single-node deployment and allows zero-copy event delivery between broker simulators and consumers. For a horizontally scaled deployment, this would be replaced with Redis Streams or Kafka — each topic partitioned by `account_id` to preserve per-account ordering.

**Concurrent Event Streams**
Each broker runs an independent `setInterval` loop. Because Node.js is single-threaded, events are serialised through the event loop — no mutex is needed. For CPU-bound processing at very high throughput, Worker Threads or a dedicated process per broker would be used.

**Mean-Reversion Bias (Simulator)**
The broker simulator applies a `tanh`-based mean-reversion bias to side selection. When an account is long, the probability of a SELL increases proportionally to position size; when short, the probability of BUY increases. This prevents positions from growing unboundedly while still allowing realistic violations under burst conditions. Configurable via `meanReversionStrength` (0 = fully random, 1 = always reverts).

**Sequence Numbers and Out-of-Order Detection**
Each broker emits a monotonically increasing `seq` number per account. The `EventIngester` tracks the last seen sequence per `(broker, account_id)` key and logs a warning on any gap or regression. Events are still processed — strict causal ordering would require a persistent log (see optional enhancements).

**Deduplication (EventDeduplicator)**
Execution IDs are stored in a time-bounded `Map<string, timestamp>`. Entries older than 60 seconds are evicted on a periodic timer. This bounds memory to roughly `(events/sec) × 60` unique IDs. A Redis SET with TTL is the production equivalent.

**Average-Cost PnL Accounting**
We use average-cost (not FIFO/LIFO) per instrument per account:
- Simpler to implement correctly and audit
- Commutative for fills that don't cross zero (order-independent result)
- Widely used in prop-firm platforms

**Position Flip Handling**
When a fill crosses zero (e.g. long 2, sell 5 → short 3):
1. Close 2 contracts — realise PnL at fill price vs avg_price
2. Open 3 contracts in the opposite direction at fill price

**Three-Level Risk Status**
| Status | Condition |
|---|---|
| `OK` | All metrics below 80% of their limits |
| `WARNING` | Any metric has crossed 80% of its limit |
| `VIOLATED` | Any metric has crossed its limit |

Violations are cleared automatically when the account recovers below the threshold — no stale alerts persist across evaluations.

**Account Locking**
Critical violations (MAX_DAILY_LOSS, TRAILING_DRAWDOWN) set `account.locked = true`. Subsequent execution events for that account are rejected by the `EventIngester` and counted in the `rejected` stat. Accounts are unlocked via the `POST /api/accounts/:id/unlock` endpoint or automatically on daily reset.

**Daily Reset**
`AccountStateEngine.resetDaily()` zeroes all daily PnL fields, trade stats, violations, and the locked flag. It is scheduled at market close (default 21:00 UTC, configurable via `config.marketCloseUtc`). The scheduler checks every minute using `setInterval` with `unref()` so it does not prevent process exit.

**Dashboard WebSocket Feed**
- **Debounce**: Updates are batched with a 50ms flush timer per account, preventing redundant renders during burst events while staying near-real-time.
- **Snapshot on subscribe**: The server immediately sends the current state of all subscribed accounts, so clients never see a blank dashboard on connect.
- **Heartbeat**: A 30-second ping/pong cycle detects and terminates unresponsive connections.
- **Message validation**: Incoming subscribe messages are validated with a `zod` schema before processing.

### Reliability Scenarios

| Scenario | Handling |
|---|---|
| Duplicate executions | `EventDeduplicator` — O(1) lookup, TTL-based memory-bounded eviction |
| Out-of-order events | Sequence gap detection + warning log; idempotent processing via exec_id dedup |
| Network latency | Broker events carry source timestamp; WS clients get snapshot immediately on reconnect |
| Broker event bursts | Node.js event loop queues absorb bursts; 50ms debounce prevents WS flood |
| Account reconnections | Stateless snapshot protocol — re-subscribe triggers full current state push |
| Critical risk breach | Account locked; new executions rejected until operator unlock or daily reset |

---

## Problem 2 — Brokerage Outage Remediation Engine

### Overview

```
Input validation (zod)
       │
       ▼
TradeRecord[]  ──────────────────────────────┐
AccountBalance[]                             │
       │                                     │
       ▼                                     │
┌──────────────────────────────────────┐     │
│         RemediationEngine            │     │
│                                      │     │
│  1. Filter: isInOutageWindow()        │     │
│     • skip qty≤0 / price≤0           │     │
│                                      │     │
│  2. For each impacted trade:          │     │
│     a. idempotency check (remediated)│     │
│     b. calculateTradePnL()           │     │
│     c. if pnl < 0:                   │     │
│        i.  write audit entry  ◄──────┼─ WAL│
│        ii. adjust balance            │     │
│        iii.mark trade remediated     │     │
└──────────────┬───────────────────────┘     │
               │                             │
               ▼                             │
  ┌────────────────────────┐                 │
  │      AuditLogger       │                 │
  │  • append-only         │                 │
  │  • NDJSON file persist │                 │
  │  • written before      │                 │
  │    balance mutation    │◄────────────────┘
  └────────────┬───────────┘
               │
               ▼
  ┌────────────────────────────────┐
  │    ReconciliationEngine        │
  │  • internal vs broker balance  │
  │  • $0.01 float tolerance       │
  │  • PASSED / FAILED summary     │
  └────────────────────────────────┘
```

### Key Design Decisions

**Input Validation (zod)**
The outage window parameters are validated with a `zod` schema before any processing begins. Checks include valid ISO 8601 UTC format and `start < end` ordering. Invalid input throws immediately with a descriptive error message.

**Data Integrity Guards**
Trades with `qty ≤ 0` or non-positive prices are skipped with a warning log before the window filter is applied. This prevents garbage-in from corrupting account balances.

**Idempotency**
Each `TradeRecord` carries `remediated: boolean` and `remediation_run_id`. Before processing, the engine checks this flag. If already set, the trade is skipped and the skip is recorded in the audit log. This ensures reruns produce a deterministic no-op for already-processed trades.

**Write-Ahead Log (WAL) Pattern**
The audit entry is written _before_ the balance is mutated. If the process crashes mid-remediation, the audit log shows exactly what was intended — a recovery process can complete or roll back based on that record.

**NDJSON File Persistence**
`AuditLogger` optionally accepts a log directory. Each entry is appended as a single JSON line (`appendFileSync`) before returning. This is synchronous-on-write to preserve the WAL guarantee. In production, this would target a database or durable object store.

**Outage Window Logic**
A trade is impacted if _either_ `entry_time` or `exit_time` falls within `[windowStart, windowEnd)`. The end is exclusive to avoid boundary ambiguity.

**PnL Formula**
```
PnL = (exit_price - entry_price) × qty × contract_multiplier
```
Positive PnL = profitable → left untouched.
Negative PnL = loss → balance restored by `abs(PnL)`.

**Contract Multiplier Resolution**
Instrument symbols (`NQH4`, `ESM4`) have a variable-length alphabetic prefix. Known multipliers are sorted by key length descending and matched by prefix — `MNQ` is matched before `NQ`, preventing false positives.

**Dry-Run Mode**
All filtering, PnL calculation, and audit logging proceed normally. Balance mutations and trade-marking are skipped. The report shows what _would_ have been remediated, allowing operators to validate before executing.

**Reconciliation Summary**
`ReconciliationEngine.reconcile()` returns a `ReconciliationSummary` with:
- Per-account `MATCH` / `MISMATCH` diffs
- Total matched vs mismatched count
- Top-level `result: 'PASSED' | 'FAILED'`

Discrepancies larger than $0.01 (floating-point tolerance) are flagged as `MISMATCH` and logged as warnings.

### Data Integrity Guarantees

| Requirement | Implementation |
|---|---|
| Idempotent reruns | `trade.remediated` flag checked before every trade |
| No double remediation | Same flag — second run sees `remediated=true`, skips with audit entry |
| Full audit trail | Every action recorded with `run_id`, timestamps, before/after values |
| Determinism | Same input → same output; no randomness in remediation logic |
| Input safety | zod schema validates window; data guards skip malformed trades |

### Optional Enhancements (architected for, not implemented)

- **Kafka / Redis Streams** — replace EventEmitter with a persistent, replayable event log partitioned by `account_id`
- **Replayable event log** — store all broker events with sequence numbers; reconstruct full account state from offset 0
- **Distributed scaling** — shard accounts across nodes; each node owns a partition and runs its own risk engine
- **Reconciliation diff engine** — field-level comparison with automatic discrepancy ticket filing
