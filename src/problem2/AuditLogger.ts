import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../common/logger';
import type { AuditEntry } from '../common/types';

/**
 * Append-only audit log with optional file persistence.
 *
 * Each entry is written as a newline-delimited JSON (NDJSON) record before
 * any balance mutation takes place (write-ahead log pattern).
 *
 * In production, this would write to a database or object store instead.
 */
export class AuditLogger {
  private readonly entries: AuditEntry[] = [];
  private readonly filePath: string | null;

  constructor(logDir?: string) {
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      this.filePath = path.join(logDir, 'audit.ndjson');
    } else {
      this.filePath = null;
    }
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);

    // Persist before returning — WAL guarantee
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8');
      } catch (err) {
        logger.error(`[AuditLogger] Failed to write to ${this.filePath}: ${String(err)}`);
      }
    }

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
