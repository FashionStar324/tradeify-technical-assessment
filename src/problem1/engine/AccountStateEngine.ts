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
 * PnL methodology
 * ───────────────
 * We use average-cost accounting per instrument per account.
 *
 * When a fill INCREASES the existing position:
 *   new_avg = (old_qty * old_avg + fill_qty * fill_price) / (old_qty + fill_qty)
 *
 * When a fill REDUCES the existing position:
 *   realized_pnl += fill_qty * (fill_price - avg_price) * multiplier  [for long]
 *   realized_pnl += fill_qty * (avg_price - fill_price) * multiplier  [for short]
 *
 * When the fill CROSSES zero (position flip), we close the existing side first,
 * then open the remainder in the opposite direction.
 *
 * Unrealized PnL is recomputed on every market price tick.
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

  handleExecution(event: ExecutionEvent): void {
    const state = this.getOrCreate(event.account_id);
    const pos = this.getOrCreatePosition(state, event.instrument);
    const multiplier = getContractMultiplier(event.instrument);

    const fillQty = event.qty;
    const fillPrice = event.price;
    const isLongFill = event.side === 'BUY';

    // Direction of the fill relative to the instrument sign convention:
    // BUY adds +fillQty, SELL adds -fillQty
    const signedFill = isLongFill ? fillQty : -fillQty;

    if (pos.position_qty === 0) {
      // Opening a fresh position
      pos.position_qty = signedFill;
      pos.avg_price = fillPrice;
    } else if (Math.sign(pos.position_qty) === Math.sign(signedFill)) {
      // Adding to an existing position — update average cost
      const totalQty = pos.position_qty + signedFill;
      pos.avg_price =
        (Math.abs(pos.position_qty) * pos.avg_price + Math.abs(signedFill) * fillPrice) /
        Math.abs(totalQty);
      pos.position_qty = totalQty;
    } else {
      // Reducing or flipping position
      const closeQty = Math.min(Math.abs(signedFill), Math.abs(pos.position_qty));
      const openRemainder = Math.abs(signedFill) - closeQty;

      // Realise PnL for the closed portion:
      //   SELL closes a LONG  → profit = (sell_price - avg_price)
      //   BUY  closes a SHORT → profit = (avg_price  - buy_price)
      const priceDiff = isLongFill
        ? pos.avg_price - fillPrice  // BUY to close SHORT
        : fillPrice - pos.avg_price; // SELL to close LONG
      const realized = closeQty * priceDiff * multiplier;
      pos.realized_pnl += realized;
      state.realized_pnl += realized;

      // Track win/loss for win rate
      if (realized > 0) state.winning_trades++;
      state.trade_count++;
      state.win_rate =
        state.trade_count > 0 ? state.winning_trades / state.trade_count : 0;

      if (openRemainder > 0) {
        // Position flipped — open remainder in opposite direction
        pos.position_qty = isLongFill ? openRemainder : -openRemainder;
        pos.avg_price = fillPrice;
      } else {
        // Position reduced (possibly to zero)
        pos.position_qty += signedFill;
        if (pos.position_qty === 0) pos.avg_price = 0;
        // avg_price unchanged when just reducing an existing position
      }
    }

    state.last_updated = new Date().toISOString();
    this.updateDailyPnL(state);
    this.emit('update', this.toSnapshot(state));

    logger.debug(
      `[AccountStateEngine] ${event.account_id} ${event.side} ${event.qty} ${event.instrument} @ ${event.price}`,
    );
  }

  handlePositionUpdate(update: PositionUpdate): void {
    // Broker-authoritative position updates reconcile our computed state.
    // We trust the broker's position_qty and avg_price but keep our own PnL history.
    const state = this.getOrCreate(update.account_id);
    const pos = this.getOrCreatePosition(state, update.instrument);

    pos.position_qty = update.position_qty;
    pos.avg_price = update.avg_price;

    state.last_updated = new Date().toISOString();
    this.updateDailyPnL(state);
    this.emit('update', this.toSnapshot(state));
  }

  handleMarketPrice(feed: MarketPriceFeed): void {
    let changed = false;

    for (const state of this.accounts.values()) {
      const pos = state.positions[feed.instrument];
      if (!pos || pos.position_qty === 0) continue;

      const multiplier = getContractMultiplier(feed.instrument);
      const priceDiff = feed.price - pos.avg_price;
      const newUnrealized = pos.position_qty * priceDiff * multiplier;

      if (newUnrealized !== pos.unrealized_pnl) {
        pos.unrealized_pnl = newUnrealized;
        changed = true;
      }
    }

    if (changed) {
      for (const state of this.accounts.values()) {
        this.updateDailyPnL(state);
        this.emit('update', this.toSnapshot(state));
      }
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private getOrCreate(accountId: string): AccountState {
    if (!this.accounts.has(accountId)) {
      this.accounts.set(accountId, {
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
        last_updated: new Date().toISOString(),
      });
    }
    return this.accounts.get(accountId)!;
  }

  private getOrCreatePosition(state: AccountState, instrument: string): InstrumentPosition {
    if (!state.positions[instrument]) {
      state.positions[instrument] = {
        instrument,
        position_qty: 0,
        avg_price: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
      };
    }
    return state.positions[instrument];
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
      last_updated: state.last_updated,
    };
  }
}
