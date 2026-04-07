import { EventEmitter } from 'events';
import { getContractMultiplier } from '../../common/config';
import { logger } from '../../common/logger';
import type {
  AccountSnapshot,
  AccountState,
  ExecutionEvent,
  InstrumentPosition,
  MarketPriceFeed,
  PositionUpdate,
} from '../../common/types';

/**
 * Maintains live account state for all accounts.
 *
 * Emits `'update'` with an `AccountSnapshot` every time state changes.
 *
 * PnL methodology — average-cost accounting per instrument per account.
 *
 * When a fill INCREASES the existing position:
 *   new_avg = (old_qty * old_avg + fill_qty * fill_price) / (old_qty + fill_qty)
 *
 * When a fill REDUCES the existing position:
 *   realized_pnl += fill_qty * (fill_price - avg_price) * multiplier  [SELL closing LONG]
 *   realized_pnl += fill_qty * (avg_price - fill_price) * multiplier  [BUY  closing SHORT]
 *
 * When the fill CROSSES zero (position flip), we close the existing side first,
 * then open the remainder in the opposite direction.
 */
export class AccountStateEngine extends EventEmitter {
  private readonly accounts = new Map<string, AccountState>();

  // ─── Public API ────────────────────────────────────────────────────────────

  getAccount(accountId: string): AccountState | undefined {
    return this.accounts.get(accountId);
  }

  getAllAccounts(): AccountState[] {
    return Array.from(this.accounts.values());
  }

  /**
   * Process an execution fill.
   * Returns false (without mutating state) if the account is locked.
   */
  handleExecution(event: ExecutionEvent): boolean {
    const state = this.getOrCreate(event.account_id);

    if (state.locked) {
      logger.warn(
        `[AccountStateEngine] Execution rejected — account ${event.account_id} is LOCKED`,
      );
      return false;
    }

    const pos = this.getOrCreatePosition(state, event.instrument);
    const multiplier = getContractMultiplier(event.instrument);

    const fillQty = event.qty;
    const fillPrice = event.price;
    const isLongFill = event.side === 'BUY';
    const signedFill = isLongFill ? fillQty : -fillQty;

    if (pos.position_qty === 0) {
      pos.position_qty = signedFill;
      pos.avg_price = fillPrice;
    } else if (Math.sign(pos.position_qty) === Math.sign(signedFill)) {
      // Adding to existing position — update average cost
      const totalQty = pos.position_qty + signedFill;
      pos.avg_price =
        (Math.abs(pos.position_qty) * pos.avg_price + Math.abs(signedFill) * fillPrice) /
        Math.abs(totalQty);
      pos.position_qty = totalQty;
    } else {
      // Reducing or flipping position
      const closeQty = Math.min(Math.abs(signedFill), Math.abs(pos.position_qty));
      const openRemainder = Math.abs(signedFill) - closeQty;

      // Realise PnL:
      //   SELL closes LONG  → profit = (sell_price - avg_price)
      //   BUY  closes SHORT → profit = (avg_price  - buy_price)
      const priceDiff = isLongFill
        ? pos.avg_price - fillPrice  // BUY to close SHORT
        : fillPrice - pos.avg_price; // SELL to close LONG
      const realized = closeQty * priceDiff * multiplier;
      pos.realized_pnl += realized;
      state.realized_pnl += realized;

      if (realized > 0) state.winning_trades++;
      state.trade_count++;
      state.win_rate =
        state.trade_count > 0 ? state.winning_trades / state.trade_count : 0;

      if (openRemainder > 0) {
        pos.position_qty = isLongFill ? openRemainder : -openRemainder;
        pos.avg_price = fillPrice;
      } else {
        pos.position_qty += signedFill;
        if (pos.position_qty === 0) pos.avg_price = 0;
      }
    }

    state.last_updated = new Date().toISOString();
    this.updateDailyPnL(state);
    this.emit('update', this.toSnapshot(state));
    return true;
  }

  handlePositionUpdate(update: PositionUpdate): void {
    const state = this.getOrCreate(update.account_id);
    const pos = this.getOrCreatePosition(state, update.instrument);
    pos.position_qty = update.position_qty;
    pos.avg_price = update.avg_price;
    state.last_updated = new Date().toISOString();
    this.updateDailyPnL(state);
    this.emit('update', this.toSnapshot(state));
  }

  handleMarketPrice(feed: MarketPriceFeed): void {
    // Track only accounts whose unrealized PnL actually changed so we don't
    // broadcast O(all accounts) snapshots on every tick regardless of exposure.
    const changedIds = new Set<string>();

    for (const state of this.accounts.values()) {
      const pos = state.positions[feed.instrument];
      if (!pos || pos.position_qty === 0) continue;

      const multiplier = getContractMultiplier(feed.instrument);
      const newUnrealized = pos.position_qty * (feed.price - pos.avg_price) * multiplier;

      if (newUnrealized !== pos.unrealized_pnl) {
        pos.unrealized_pnl = newUnrealized;
        changedIds.add(state.account_id);
      }
    }

    for (const accountId of changedIds) {
      const state = this.accounts.get(accountId);
      if (!state) continue;
      this.updateDailyPnL(state);
      this.emit('update', this.toSnapshot(state));
    }
  }

  /**
   * Resets daily PnL fields for all accounts.
   * Should be called at market close (e.g. 5 PM ET).
   */
  resetDaily(): void {
    for (const state of this.accounts.values()) {
      state.realized_pnl = 0;
      state.unrealized_pnl = 0;
      state.daily_pnl = 0;
      state.peak_daily_pnl = 0;
      state.trade_count = 0;
      state.winning_trades = 0;
      state.win_rate = 0;
      state.violations = [];
      state.risk_status = 'OK';
      state.locked = false;
      state.last_updated = new Date().toISOString();
      this.emit('update', this.toSnapshot(state));
    }
    logger.info('[AccountStateEngine] Daily reset completed');
  }

  /**
   * Manually unlock a locked account (operator action).
   */
  unlockAccount(accountId: string): boolean {
    const state = this.accounts.get(accountId);
    if (!state) return false;
    state.locked = false;
    state.last_updated = new Date().toISOString();
    this.emit('update', this.toSnapshot(state));
    logger.info(`[AccountStateEngine] Account ${accountId} manually unlocked`);
    return true;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private getOrCreate(accountId: string): AccountState {
    const existing = this.accounts.get(accountId);
    if (existing) return existing;
    const state: AccountState = {
      account_id: accountId,
      positions: {},
      total_net_position: 0,
      realized_pnl: 0,
      unrealized_pnl: 0,
      daily_pnl: 0,
      peak_daily_pnl: 0,
      trade_count: 0,
      winning_trades: 0,
      win_rate: 0,
      risk_status: 'OK',
      violations: [],
      locked: false,
      last_updated: new Date().toISOString(),
    };
    this.accounts.set(accountId, state);
    return state;
  }

  private getOrCreatePosition(state: AccountState, instrument: string): InstrumentPosition {
    const existing = state.positions[instrument];
    if (existing) return existing;
    const pos: InstrumentPosition = {
      instrument,
      position_qty: 0,
      avg_price: 0,
      realized_pnl: 0,
      unrealized_pnl: 0,
    };
    state.positions[instrument] = pos;
    return pos;
  }

  private updateDailyPnL(state: AccountState): void {
    const totalUnrealized = Object.values(state.positions).reduce(
      (sum, p) => sum + p.unrealized_pnl,
      0,
    );
    state.unrealized_pnl = totalUnrealized;
    state.daily_pnl = state.realized_pnl + state.unrealized_pnl;

    if (state.daily_pnl > state.peak_daily_pnl) {
      state.peak_daily_pnl = state.daily_pnl;
    }

    state.total_net_position = Object.values(state.positions).reduce(
      (sum, p) => sum + Math.abs(p.position_qty),
      0,
    );
  }

  toSnapshot(state: AccountState): AccountSnapshot {
    return {
      account_id: state.account_id,
      positions: Object.values(state.positions).map((p) => ({
        instrument: p.instrument,
        position_qty: p.position_qty,
        avg_price: parseFloat(p.avg_price.toFixed(2)),
        unrealized_pnl: parseFloat(p.unrealized_pnl.toFixed(2)),
      })),
      total_net_position: state.total_net_position,
      realized_pnl: parseFloat(state.realized_pnl.toFixed(2)),
      unrealized_pnl: parseFloat(state.unrealized_pnl.toFixed(2)),
      daily_pnl: parseFloat(state.daily_pnl.toFixed(2)),
      trade_count: state.trade_count,
      win_rate: parseFloat(state.win_rate.toFixed(4)),
      risk_status: state.risk_status,
      violations: state.violations.map((v) => v.message),
      locked: state.locked,
      last_updated: state.last_updated,
    };
  }
}
