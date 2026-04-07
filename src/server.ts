/**
 * Unified HTTP + WebSocket server.
 *
 * Endpoints:
 *   GET  /health                        — liveness check
 *   GET  /api/accounts                  — list all account snapshots (paginated)
 *   GET  /api/accounts/:id              — get single account snapshot
 *   POST /api/accounts/:id/unlock       — unlock a locked account
 *   GET  /api/stats                     — ingester throughput stats
 *   POST /api/remediation/run           — run Problem 2 remediation
 *   POST /api/remediation/dry-run       — dry-run remediation (no mutations)
 *   GET  /api/remediation/report        — last remediation report
 *   GET  /api/remediation/audit         — full audit log (paginated)
 *   GET  /api/remediation/trades        — all trades with remediation status
 *   GET  /api/remediation/reconcile     — broker reconciliation diff
 *   WS   /ws                            — live dashboard feed
 */
import { EventEmitter } from 'events';
import http from 'http';
import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
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

// ─── Problem 1 ────────────────────────────────────────────────────────────────
const bus = new EventEmitter();
bus.setMaxListeners(50);
const p1 = createProblem1(bus);
const feed = new DashboardFeed();

p1.accountEngine.on('update', (snapshot) => feed.push(snapshot));
p1.riskEngine.on('violation', (msg: string) => logger.warn(`[RISK] ${msg}`));

// ─── Problem 2 ────────────────────────────────────────────────────────────────
const p2Trades = SAMPLE_TRADES.map((t) => ({ ...t }));
const p2Balances = ACCOUNT_BALANCES.map((b) => ({ ...b }));
const remediationEngine = new RemediationEngine(p2Trades, p2Balances);
const reconciliationEngine = new ReconciliationEngine();
let lastRemediationReport: RemediationReport | null = null;

// ─── Validation schemas ───────────────────────────────────────────────────────
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Problem 1: account state
app.get('/api/accounts', (req, res) => {
  const parsed = PaginationSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { page, limit } = parsed.data;
  const all = p1.accountEngine.getAllAccounts().map((s) => p1.accountEngine.toSnapshot(s));
  const slice = all.slice((page - 1) * limit, page * limit);
  return res.json({ data: slice, total: all.length, page, limit });
});

app.get('/api/accounts/:id', (req, res) => {
  const state = p1.accountEngine.getAccount(req.params['id'] ?? '');
  if (!state) return res.status(404).json({ error: 'Account not found' });
  return res.json(p1.accountEngine.toSnapshot(state));
});

app.post('/api/accounts/:id/unlock', (req, res) => {
  const ok = p1.accountEngine.unlockAccount(req.params['id'] ?? '');
  if (!ok) return res.status(404).json({ error: 'Account not found' });
  return res.json({ message: `Account ${req.params['id']} unlocked` });
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
  if (!lastRemediationReport) {
    return res.status(404).json({ error: 'No remediation run yet. POST /api/remediation/run first.' });
  }
  return res.json(lastRemediationReport);
});

app.get('/api/remediation/audit', (req, res) => {
  const parsed = PaginationSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { page, limit } = parsed.data;
  const all = remediationEngine.getAuditLog();
  const slice = Array.from(all).slice((page - 1) * limit, page * limit);
  return res.json({ data: slice, total: all.length, page, limit });
});

app.get('/api/remediation/trades', (req, res) => {
  const parsed = PaginationSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { page, limit } = parsed.data;
  const all = remediationEngine.getTrades();
  const slice = Array.from(all).slice((page - 1) * limit, page * limit);
  return res.json({ data: slice, total: all.length, page, limit });
});

app.get('/api/remediation/reconcile', (_req, res) => {
  const currentBalances = ACCOUNT_BALANCES.map(
    (orig) => remediationEngine.getBalance(orig.account_id) ?? orig,
  );
  const summary = reconciliationEngine.reconcile(currentBalances);
  res.json(summary);
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// ─── Server start ─────────────────────────────────────────────────────────────
const server = http.createServer(app);

feed.attach(
  server,
  (id) => {
    const s = p1.accountEngine.getAccount(id);
    return s ? p1.accountEngine.toSnapshot(s) : undefined;
  },
  () => p1.accountEngine.getAllAccounts().map((s) => p1.accountEngine.toSnapshot(s)),
);

server.listen(config.server.port, () => {
  logger.info(`Server running on http://localhost:${config.server.port}`);
  logger.info(`WebSocket feed at  ws://localhost:${config.server.port}/ws`);
  p1.start();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Server] ${signal} received — shutting down gracefully`);

  // Stop producing new events first
  p1.stop();
  feed.stop();

  // Allow in-flight requests up to 5 s, then force-close
  server.close(() => {
    logger.info('[Server] HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
