import { v4 as uuidv4 } from 'uuid';
import { logger } from '../common/logger';
import type { AuditEntry } from '../common/types';

/**
 * Append-only in-memory audit log.
 * In production this would be persisted to a database / object store
 * before any remediation action is taken (write-ahead log pattern).
 */
export class AuditLogger {
  private readonly entries: AuditEntry[] = [];

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    logger.debug(`[Audit] ${full.action} ${full.entity_type}:${full.entity_id}`);
    return full;
  }

  getAll(): Readonly<AuditEntry[]> {
    return this.entries;
  }

  getByRunId(runId: string): AuditEntry[] {
    return this.entries.filter((e) => e.run_id === runId);
  }

  getByEntityId(entityId: string): AuditEntry[] {
    return this.entries.filter((e) => e.entity_id === entityId);
  }
}
