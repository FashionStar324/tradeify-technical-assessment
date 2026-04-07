import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { logger } from '../../common/logger';
import type { AccountSnapshot } from '../../common/types';

type DashboardMessage =
  | { type: 'snapshot'; data: AccountSnapshot }
  | { type: 'subscribed'; account_ids: string[] }
  | { type: 'ping' };

/**
 * WebSocket server that streams live account state to connected clients.
 *
 * Protocol:
 *   Client → Server:
 *     { "subscribe": ["TRD-44821", "TRD-88312"] }   subscribe to specific accounts
 *     { "subscribe": "ALL" }                          subscribe to all accounts
 *
 *   Server → Client:
 *     { "type": "subscribed", "account_ids": [...] }
 *     { "type": "snapshot", "data": <AccountSnapshot> }
 *     { "type": "ping" }   keepalive every 30s
 */
export class DashboardFeed {
  private wss: WebSocketServer | null = null;
  /** ws client → set of subscribed account IDs ('*' means all) */
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      logger.info(`[DashboardFeed] Client connected from ${ip}`);
      this.subscriptions.set(ws, new Set());

      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
      ws.on('close', () => {
        this.subscriptions.delete(ws);
        logger.info(`[DashboardFeed] Client disconnected from ${ip}`);
      });
      ws.on('error', (err) => logger.error(`[DashboardFeed] WS error: ${err.message}`));
    });

    // Keepalive ping
    this.pingTimer = setInterval(() => {
      this.broadcast({ type: 'ping' }, '*');
    }, 30_000);

    logger.info('[DashboardFeed] WebSocket server attached at /ws');
  }

  /** Push a snapshot update to all clients subscribed to this account */
  push(snapshot: AccountSnapshot): void {
    const message: DashboardMessage = { type: 'snapshot', data: snapshot };
    this.broadcast(message, snapshot.account_id);
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.wss?.close();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, raw: string): void {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if (msg['subscribe'] === 'ALL') {
        this.subscriptions.get(ws)!.add('*');
        this.send(ws, { type: 'subscribed', account_ids: ['ALL'] });
      } else if (Array.isArray(msg['subscribe'])) {
        const ids = (msg['subscribe'] as string[]).filter((id) => typeof id === 'string');
        const subs = this.subscriptions.get(ws)!;
        ids.forEach((id) => subs.add(id));
        this.send(ws, { type: 'subscribed', account_ids: ids });
      }
    } catch {
      logger.warn('[DashboardFeed] Received invalid JSON from client');
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
