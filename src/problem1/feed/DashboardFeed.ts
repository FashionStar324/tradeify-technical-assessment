import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { z } from 'zod';
import { logger } from '../../common/logger';
import type { AccountSnapshot } from '../../common/types';

type DashboardMessage =
  | { type: 'snapshot'; data: AccountSnapshot }
  | { type: 'subscribed'; account_ids: string[] }
  | { type: 'ping' };

const SubscribeSchema = z.union([
  z.object({ subscribe: z.literal('ALL') }),
  z.object({ subscribe: z.array(z.string().min(1)) }),
]);

/**
 * WebSocket server that streams live account state to connected clients.
 *
 * Protocol:
 *   Client → Server:
 *     { "subscribe": ["TRD-44821"] }   subscribe to specific accounts
 *     { "subscribe": "ALL" }           subscribe to all accounts
 *
 *   Server → Client:
 *     { "type": "subscribed", "account_ids": [...] }
 *     { "type": "snapshot", "data": <AccountSnapshot> }
 *     { "type": "ping" }
 *
 * Features:
 *   - 50ms debounce per account to prevent flooding during burst events
 *   - Full current state sent immediately on subscribe
 *   - Heartbeat with automatic dead-connection cleanup
 */
export class DashboardFeed {
  private wss: WebSocketServer | null = null;

  /** ws → set of subscribed account IDs ('*' = all) */
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  /** ws → alive flag for heartbeat */
  private readonly alive = new Map<WebSocket, boolean>();

  /** Pending debounced snapshots: account_id → latest snapshot */
  private readonly pending = new Map<string, AccountSnapshot>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  attach(
    server: Server,
    getSnapshot: (id: string) => AccountSnapshot | undefined,
    getAllSnapshots: () => AccountSnapshot[],
  ): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    // getSnapshot and getAllSnapshots are closed over here rather than stored as
    // nullable class fields — this removes the need for null-guards on every call
    // site and makes it impossible to call handleMessage before attach().
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      logger.info(`[DashboardFeed] Client connected from ${ip}`);
      this.subscriptions.set(ws, new Set());
      this.alive.set(ws, true);

      ws.on('pong', () => this.alive.set(ws, true));
      ws.on('message', (raw) =>
        this.handleMessage(ws, raw.toString(), getSnapshot, getAllSnapshots),
      );
      ws.on('close', () => {
        this.subscriptions.delete(ws);
        this.alive.delete(ws);
        logger.info(`[DashboardFeed] Client disconnected from ${ip}`);
      });
      ws.on('error', (err) => logger.error(`[DashboardFeed] WS error: ${err.message}`));
    });

    // Heartbeat — ping all clients every 30s, terminate unresponsive ones
    this.heartbeatTimer = setInterval(() => {
      for (const [ws] of this.subscriptions) {
        if (!this.alive.get(ws)) {
          logger.warn('[DashboardFeed] Terminating unresponsive client');
          ws.terminate();
          this.subscriptions.delete(ws);
          this.alive.delete(ws);
          continue;
        }
        this.alive.set(ws, false);
        ws.ping();
      }
    }, 30_000);

    logger.info('[DashboardFeed] WebSocket server attached at /ws');
  }

  /** Queue a snapshot update — flushed after 50ms debounce */
  push(snapshot: AccountSnapshot): void {
    this.pending.set(snapshot.account_id, snapshot);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 50);
    }
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.wss?.close();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private flush(): void {
    this.flushTimer = null;
    for (const snapshot of this.pending.values()) {
      this.broadcast({ type: 'snapshot', data: snapshot }, snapshot.account_id);
    }
    this.pending.clear();
  }

  private handleMessage(
    ws: WebSocket,
    raw: string,
    getSnapshot: (id: string) => AccountSnapshot | undefined,
    getAllSnapshots: () => AccountSnapshot[],
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('[DashboardFeed] Received invalid JSON from client');
      return;
    }

    const result = SubscribeSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn('[DashboardFeed] Invalid subscribe message');
      return;
    }

    const msg = result.data;
    const subs = this.subscriptions.get(ws)!;

    if (msg.subscribe === 'ALL') {
      subs.add('*');
      this.send(ws, { type: 'subscribed', account_ids: ['ALL'] });
      for (const snap of getAllSnapshots()) {
        this.send(ws, { type: 'snapshot', data: snap });
      }
    } else {
      const ids = msg.subscribe;
      ids.forEach((id) => subs.add(id));
      this.send(ws, { type: 'subscribed', account_ids: ids });
      for (const id of ids) {
        const snap = getSnapshot(id);
        if (snap) this.send(ws, { type: 'snapshot', data: snap });
      }
    }
  }

  private broadcast(message: DashboardMessage, accountId: string): void {
    const json = JSON.stringify(message);
    for (const [ws, subs] of this.subscriptions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (subs.has('*') || subs.has(accountId)) {
        ws.send(json);
      }
    }
  }

  private send(ws: WebSocket, message: DashboardMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
