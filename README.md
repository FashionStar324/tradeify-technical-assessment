# Tradeify — Senior Full-Stack Engineering Assessment

Node.js / TypeScript implementation of two real-time financial infrastructure problems.

## Requirements

- Node.js ≥ 18
- npm ≥ 9

## Setup

```bash
npm install
```

## Running

### Full server (Problem 1 + Problem 2 via HTTP/WebSocket)

```bash
npm run dev
```

Server starts at `http://localhost:3000`.

### Problem 1 only (terminal output)

```bash
npm run dev:p1
```

### Problem 2 only (terminal output)

```bash
npm run dev:p2
```

## API Endpoints

### Problem 1 — Live Trading Dashboard

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/api/accounts` | All account snapshots |
| `GET` | `/api/accounts/:id` | Single account snapshot |
| `GET` | `/api/stats` | Event ingester throughput stats |
| `WS` | `/ws` | Live dashboard WebSocket feed |

#### WebSocket Protocol

Connect to `ws://localhost:3000/ws`, then send:

```json
{ "subscribe": ["TRD-44821", "TRD-88312"] }
```

or subscribe to all accounts:

```json
{ "subscribe": "ALL" }
```

You will receive real-time `AccountSnapshot` messages:

```json
{
  "type": "snapshot",
  "data": {
    "account_id": "TRD-44821",
    "positions": [{ "instrument": "NQH4", "position_qty": 2, "avg_price": 18210.25, "unrealized_pnl": 118.75 }],
    "total_net_position": 2,
    "realized_pnl": 400.00,
    "unrealized_pnl": 118.75,
    "daily_pnl": 518.75,
    "trade_count": 3,
    "win_rate": 0.6667,
    "risk_status": "OK",
    "violations": [],
    "last_updated": "2026-03-10T09:30:05.000Z"
  }
}
```

### Problem 2 — Remediation Engine

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/remediation/dry-run` | Preview remediation (no mutations) |
| `POST` | `/api/remediation/run` | Execute remediation |
| `GET` | `/api/remediation/report` | Last remediation report |
| `GET` | `/api/remediation/audit` | Full audit log |
| `GET` | `/api/remediation/reconcile` | Broker reconciliation diff |

## Tests

```bash
npm test
npm run test:coverage
```

## Build

```bash
npm run build
npm start
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for detailed design decisions, reliability considerations, and system diagrams.

## Assumptions

1. **Single-node deployment** — the EventEmitter bus is in-process. Horizontal scaling would require replacing it with Kafka or Redis Streams (noted in architecture doc).
2. **Average-cost PnL accounting** — used instead of FIFO/LIFO. Appropriate for prop-firm accounts.
3. **Outage window is UTC** — `09:30 EST = 14:30 UTC`. Sample data uses UTC timestamps.
4. **Contract multiplier by prefix** — `NQH4 → NQ → 20`, `ESM4 → ES → 50`. Unknown instruments default to multiplier 1.
5. **Position updates from broker are authoritative** — broker `PositionUpdate` events overwrite computed position/avg_price but preserve our PnL history.
6. **Trailing drawdown resets daily** — `peak_daily_pnl` tracks the intraday high-water mark of `daily_pnl`.
