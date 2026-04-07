# Tradeify — Senior Full-Stack Engineering Assessment

Node.js / TypeScript implementation of two real-time financial infrastructure problems.

## Requirements

- Node.js ≥ 18
- npm ≥ 9

## Setup

```bash
npm install
```

Copy the environment file and adjust as needed:

```bash
cp .env.example .env
```

## Running

### Full server (Problem 1 + Problem 2 via HTTP/WebSocket)

```bash
npm run dev
```

Server starts at `http://localhost:3000` and WebSocket at `ws://localhost:3000/ws`.

### Problem 1 only (terminal output)

```bash
npm run dev:p1
```

### Problem 2 only (terminal output)

```bash
npm run dev:p2
```

### Docker

```bash
docker compose up --build
```

## Project Structure

```
src/
├── common/
│   ├── types.ts            # All shared TypeScript interfaces
│   ├── config.ts           # Risk limits, multipliers, simulator config
│   └── logger.ts           # Winston logger
├── problem1/
│   ├── broker/
│   │   └── BrokerSimulator.ts      # 3 concurrent broker streams + market ticks
│   ├── engine/
│   │   ├── AccountStateEngine.ts   # Avg-cost PnL, positions, locked flag, daily reset
│   │   ├── EventDeduplicator.ts    # TTL-bounded execution ID dedup
│   │   └── RiskRuleEngine.ts       # OK / WARNING / VIOLATED + account locking
│   ├── feed/
│   │   └── DashboardFeed.ts        # WebSocket server, debounce, heartbeat
│   ├── EventIngester.ts            # Dedup + sequence gap detection + routing
│   └── index.ts                    # Wires all components, daily reset scheduler
├── problem2/
│   ├── data/sampleTrades.ts        # Sample trades + account balances
│   ├── PnLCalculator.ts            # Trade PnL formula + outage window filter
│   ├── AuditLogger.ts              # Append-only log with NDJSON file persistence
│   ├── RemediationEngine.ts        # Idempotent remediation, dry-run, zod validation
│   └── ReconciliationEngine.ts     # PASSED/FAILED reconciliation summary
└── server.ts                       # Express + WebSocket, all endpoints, graceful shutdown
tests/
├── problem1/                       # Unit tests: AccountStateEngine, RiskRuleEngine
├── problem2/                       # Unit tests: PnLCalculator, RemediationEngine
└── integration/                    # End-to-end pipeline tests for Problem 1
```

## API Endpoints

### Problem 1 — Live Trading Dashboard

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/api/accounts?page=1&limit=50` | All account snapshots (paginated) |
| `GET` | `/api/accounts/:id` | Single account snapshot |
| `POST` | `/api/accounts/:id/unlock` | Unlock a risk-locked account |
| `GET` | `/api/stats` | Ingester throughput stats (received / duplicates / out-of-order / rejected / processed) |
| `WS` | `/ws` | Live dashboard WebSocket feed |

#### WebSocket Protocol

Connect to `ws://localhost:3000/ws`, then send a subscribe message:

```json
{ "subscribe": ["TRD-44821", "TRD-88312"] }
```

or subscribe to all accounts:

```json
{ "subscribe": "ALL" }
```

The server immediately pushes the current state of all subscribed accounts, then streams updates in real time:

```json
{
  "type": "snapshot",
  "data": {
    "account_id": "TRD-44821",
    "positions": [
      { "instrument": "NQH4", "position_qty": 2, "avg_price": 18210.25, "unrealized_pnl": 118.75 }
    ],
    "total_net_position": 2,
    "realized_pnl": 400.00,
    "unrealized_pnl": 118.75,
    "daily_pnl": 518.75,
    "trade_count": 3,
    "win_rate": 0.6667,
    "risk_status": "OK",
    "violations": [],
    "locked": false,
    "last_updated": "2026-03-10T09:30:05.000Z"
  }
}
```

`risk_status` is one of `"OK"` | `"WARNING"` | `"VIOLATED"`.

### Problem 2 — Remediation Engine

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/remediation/dry-run` | Preview remediation (no state changes) |
| `POST` | `/api/remediation/run` | Execute remediation |
| `GET` | `/api/remediation/report` | Last remediation report |
| `GET` | `/api/remediation/audit?page=1&limit=50` | Full audit log (paginated) |
| `GET` | `/api/remediation/trades?page=1&limit=50` | All trades with remediation status |
| `GET` | `/api/remediation/reconcile` | Broker reconciliation summary (PASSED/FAILED) |

## Tests

```bash
npm test                  # run all 65 tests
npm run test:coverage     # with coverage report
```

## Build

```bash
npm run build
npm start
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for full system diagrams and design rationale.

## Risk Rules

| Rule | Limit | WARNING at | Action on violation |
|---|---|---|---|
| Max Daily Loss | -$2,500 | -$2,000 | Lock account |
| Max Position Size | 10 contracts | 8 contracts | — |
| Max Contracts Per Trade | 5 | 4 | — |
| Trailing Drawdown | $3,000 | $2,400 | Lock account |

Locked accounts reject all new execution events until unlocked via `POST /api/accounts/:id/unlock` or daily reset at market close (21:00 UTC).

## Assumptions

1. **Single-node deployment** — EventEmitter bus is in-process. Horizontal scaling requires Kafka or Redis Streams.
2. **Average-cost PnL accounting** — used instead of FIFO/LIFO. Appropriate for prop-firm accounts.
3. **Outage window is UTC** — `09:30 EST = 14:30 UTC`. Sample data uses UTC timestamps.
4. **Contract multiplier by prefix** — `NQH4 → NQ → 20`, `ESM4 → ES → 50`. Unknown instruments default to multiplier 1.
5. **Broker position updates are authoritative** — `PositionUpdate` events overwrite computed position/avg_price but preserve PnL history.
6. **Trailing drawdown resets daily** — `peak_daily_pnl` is an intraday high-water mark, reset at market close.
7. **Outage window end is exclusive** — a trade timestamped exactly at `windowEnd` is not considered impacted.
