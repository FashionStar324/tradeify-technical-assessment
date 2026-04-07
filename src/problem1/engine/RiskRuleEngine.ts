import { EventEmitter } from 'events';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import type { AccountState, ExecutionEvent, RiskStatus, RiskViolation } from '../../common/types';

/**
 * Evaluates prop-firm risk rules against account state.
 *
 * Statuses:
 *   OK       — all metrics within limits
 *   WARNING  — any metric has crossed 80% of its limit
 *   VIOLATED — any metric has crossed its limit
 *
 * Critical violations (MAX_DAILY_LOSS, TRAILING_DRAWDOWN) also set
 * `state.locked = true` to block further executions.
 *
 * Violations are CLEARED automatically when the account recovers below
 * the relevant threshold — no stale alerts.
 *
 * Emits `'violation'` with the message string when a new VIOLATED rule is
 * first detected (not on every evaluation).
 */
export class RiskRuleEngine extends EventEmitter {
  evaluate(state: AccountState, incomingExecution?: ExecutionEvent): void {
    const { risk } = config;
    const now = new Date().toISOString();
    const violations: RiskViolation[] = [];
    let newLock = false;

    // ── Rule 1: Max Daily Loss ──────────────────────────────────────────────
    if (state.daily_pnl <= risk.maxDailyLoss) {
      violations.push({
        rule: 'MAX_DAILY_LOSS',
        message: `ACCOUNT ${state.account_id} VIOLATED MAX DAILY LOSS`,
        timestamp: now,
        value: state.daily_pnl,
        threshold: risk.maxDailyLoss,
      });
      newLock = true;
    }

    // ── Rule 2: Max Position Size ───────────────────────────────────────────
    if (state.total_net_position > risk.maxPositionSize) {
      violations.push({
        rule: 'MAX_POSITION_SIZE',
        message: `ACCOUNT ${state.account_id} EXCEEDED MAX POSITION SIZE`,
        timestamp: now,
        value: state.total_net_position,
        threshold: risk.maxPositionSize,
      });
    }

    // ── Rule 3: Max Contracts Per Trade ─────────────────────────────────────
    if (incomingExecution && incomingExecution.qty > risk.maxContractsPerTrade) {
      violations.push({
        rule: 'MAX_CONTRACTS_PER_TRADE',
        message: `ACCOUNT ${state.account_id} EXCEEDED MAX CONTRACTS PER TRADE`,
        timestamp: now,
        value: incomingExecution.qty,
        threshold: risk.maxContractsPerTrade,
      });
    }

    // ── Rule 4: Trailing Drawdown ───────────────────────────────────────────
    const drawdown = state.peak_daily_pnl - state.daily_pnl;
    if (drawdown >= risk.trailingDrawdown) {
      violations.push({
        rule: 'TRAILING_DRAWDOWN',
        message: `ACCOUNT ${state.account_id} HIT TRAILING DRAWDOWN LIMIT`,
        timestamp: now,
        value: drawdown,
        threshold: risk.trailingDrawdown,
      });
      newLock = true;
    }

    // ── Emit events for newly violated rules ────────────────────────────────
    const previousRules = new Set(state.violations.map((v) => v.rule));
    for (const v of violations) {
      if (!previousRules.has(v.rule)) {
        logger.warn(`[RiskRuleEngine] ${v.message}`);
        this.emit('violation', v.message, v);
      }
    }

    // ── Update state ────────────────────────────────────────────────────────
    state.violations = violations;

    // Lock on critical violations; never auto-unlock (requires daily reset or operator action)
    if (newLock) state.locked = true;

    state.risk_status = this.deriveStatus(state, incomingExecution);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private deriveStatus(state: AccountState, exec?: ExecutionEvent): RiskStatus {
    const { risk } = config;
    const r = risk.warningThresholdRatio;

    if (state.violations.length > 0) return 'VIOLATED';

    // Check WARNING thresholds (80% of each limit)
    const drawdown = state.peak_daily_pnl - state.daily_pnl;

    // WARNING fires when a metric crosses (limit × warningThresholdRatio)
    // maxDailyLoss is negative, so multiply (not divide) to get the 80% threshold
    const atWarning =
      state.daily_pnl <= risk.maxDailyLoss * r ||        // <= -2000
      state.total_net_position >= risk.maxPositionSize * r ||   // >= 8
      drawdown >= risk.trailingDrawdown * r ||            // >= 2400
      (exec !== undefined && exec.qty >= risk.maxContractsPerTrade * r); // >= 4

    return atWarning ? 'WARNING' : 'OK';
  }
}
