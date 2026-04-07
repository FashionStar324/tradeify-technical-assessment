import { EventEmitter } from 'events';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import type { AccountState, ExecutionEvent, RiskViolation } from '../../common/types';

/**
 * Evaluates prop-firm risk rules against account state.
 *
 * Rules checked:
 *  1. Max Daily Loss       — daily_pnl <= maxDailyLoss
 *  2. Max Position Size    — total_net_position > maxPositionSize
 *  3. Max Contracts/Trade  — single-execution qty > maxContractsPerTrade
 *  4. Trailing Drawdown    — (peak_daily_pnl - daily_pnl) >= trailingDrawdown
 *
 * Emits `'violation'` with the violation message string.
 */
export class RiskRuleEngine extends EventEmitter {
  evaluate(state: AccountState, incomingExecution?: ExecutionEvent): void {
    const violations: RiskViolation[] = [];
    const { risk } = config;
    const now = new Date().toISOString();

    // Rule 1: Max Daily Loss
    if (state.daily_pnl <= risk.maxDailyLoss) {
      violations.push({
        rule: 'MAX_DAILY_LOSS',
        message: `ACCOUNT ${state.account_id} VIOLATED MAX DAILY LOSS`,
        timestamp: now,
        value: state.daily_pnl,
        threshold: risk.maxDailyLoss,
      });
    }

    // Rule 2: Max Position Size (net across all instruments)
    if (state.total_net_position > risk.maxPositionSize) {
      violations.push({
        rule: 'MAX_POSITION_SIZE',
        message: `ACCOUNT ${state.account_id} EXCEEDED MAX POSITION SIZE`,
        timestamp: now,
        value: state.total_net_position,
        threshold: risk.maxPositionSize,
      });
    }

    // Rule 3: Max Contracts Per Trade (checked on incoming execution)
    if (incomingExecution && incomingExecution.qty > risk.maxContractsPerTrade) {
      violations.push({
        rule: 'MAX_CONTRACTS_PER_TRADE',
        message: `ACCOUNT ${state.account_id} EXCEEDED MAX CONTRACTS PER TRADE`,
        timestamp: now,
        value: incomingExecution.qty,
        threshold: risk.maxContractsPerTrade,
      });
    }

    // Rule 4: Trailing Drawdown
    const drawdown = state.peak_daily_pnl - state.daily_pnl;
    if (drawdown >= risk.trailingDrawdown) {
      violations.push({
        rule: 'TRAILING_DRAWDOWN',
        message: `ACCOUNT ${state.account_id} HIT TRAILING DRAWDOWN LIMIT`,
        timestamp: now,
        value: drawdown,
        threshold: risk.trailingDrawdown,
      });
    }

    // Emit new violations (deduplicate by rule to avoid log spam)
    const existingRules = new Set(state.violations.map((v) => v.rule));
    for (const v of violations) {
      if (!existingRules.has(v.rule)) {
        logger.warn(`[RiskRuleEngine] ${v.message}`);
        this.emit('violation', v.message, v);
      }
    }

    // Update state
    state.violations = violations;
    state.risk_status =
      violations.length === 0 ? 'OK' : 'VIOLATED';
  }
}
