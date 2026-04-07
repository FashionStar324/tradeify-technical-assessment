/**
 * Unified HTTP + WebSocket server.
 *
 * Endpoints:
 *   GET  /health                   — liveness check
 *   GET  /api/accounts             — list all account snapshots
 *   GET  /api/accounts/:id         — get single account snapshot
 *   GET  /api/stats                — ingester throughput stats
 *   POST /api/remediation/run      — run Problem 2 remediation
 *   POST /api/remediation/dry-run  — dry-run remediation (no mutations)
 *   GET  /api/remediation/report   — last remediation report
 *   GET  /api/remediation/audit    — full audit log
 *   WS   /ws                       — live dashboard feed
 */
import { EventEmitter } from 'events';
import http from 'http';
import express, { NextFunction, Request, Response } from 'express';
import { config } from './common/config';
import { logger } from './common/logger';
import { createProblem1 } from './problem1/index';
import { DashboardFeed } from './problem1/feed/DashboardFeed';
import {
  ACCOUNT_BALANCES,
  OUTAGE_END,
  OUTAGE_START,
  SAMPLE_TRADES,
} from './problem2/data/sampleTrades';
import { ReconciliationEngine } from './problem2/ReconciliationEngine';
import { RemediationEngine } from './problem2/RemediationEngine';
import type { RemediationReport } from './common/types';

const app = express();
app.use(express.json());

// ── Problem 1 setup ───────────────────────────────────────────────────────────
const bus = new EventEmitter();
bus.setMaxListeners(50);
const p1 = createProblem1(bus);
const feed = new DashboardFeed();

p1.accountEngine.on('update', (snapshot) => feed.push(snapshot));
p1.riskEngine.on('violation', (msg: string) => logger.warn(`[RISK] ${msg}`));

// ── Problem 2 setup ───────────────────────────────────────────────────────────
const p2Trades = SAMPLE_TRADES.map((t) => ({ ...t }));
const p2Balances = ACCOUNT_BALANCES.map((b) => ({ ...b }));
const remediationEngine = new RemediationEngine(p2Trades, p2Balances);
const reconciliationEngine = new ReconciliationEngine();
let lastRemediationReport: RemediationReport | null = null;

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Problem 1: account state
app.get('/api/accounts', (_req, res) => {
  const accounts = p1.accountEngine
    .getAllAccounts()
    .map((s) => p1.accountEngine.toSnapshot(s));
  res.json(accounts);
});

app.get('/api/accounts/:id', (req, res) => {
  const state = p1.accountEngine.getAccount(req.params['id'] ?? '');
  if (!state) return res.status(404).json({ error: 'Account not found' });
  return res.json(p1.accountEngine.toSnapshot(state));
});

app.get('/api/stats', (_req, res) => {
  res.json(p1.ingester.getStats());
});

// Problem 2: remediation
app.post('/api/remediation/run', async (_req, res, next) => {
  try {
    const report = await remediationEngine.run(OUTAGE_START, OUTAGE_END);
    lastRemediationReport = report;
    res.json(report);
  } catch (err) {
    next(err);
  }
});

app.post('/api/remediation/dry-run', async (_req, res, next) => {
  try {
    const report = await remediationEngine.run(OUTAGE_START, OUTAGE_END, { dryRun: true });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

app.get('/api/remediation/report', (_req, res) => {
  if (!lastRemediationReport)
    return res.status(404).json({ error: 'No remediation run yet. POST /api/remediation/run first.' });
  return res.json(lastRemediationReport);
});

app.get('/api/remediation/audit', (_req, res) => {
  res.json(remediationEngine.getAuditLog());
});

app.get('/api/remediation/reconcile', (_req, res) => {
  const currentBalances = ACCOUNT_BALANCES.map(
    (orig) => remediationEngine.getBalance(orig.account_id) ?? orig,
  );
  const diffs = reconciliationEngine.reconcile(currentBalances);
  res.json(diffs);
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// ── Server start ──────────────────────────────────────────────────────────────
const server = http.createServer(app);
feed.attach(server);

server.listen(config.server.port, () => {
  logger.info(`Server running on http://localhost:${config.server.port}`);
  logger.info(`WebSocket feed at  ws://localhost:${config.server.port}/ws`);
  p1.start();
});

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  p1.stop();
  feed.stop();
  server.close(() => process.exit(0));
});
