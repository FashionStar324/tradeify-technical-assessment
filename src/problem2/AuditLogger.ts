import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../common/logger';
import type { AuditEntry } from '../common/types';

/**
 * Append-only audit log with optional file persistence.
 *
 * Each entry is written as a newline-delimited JSON (NDJSON) record.
 * File I/O uses a WriteStream (non-blocking, OS-buffered) rather than
 * appendFileSync to avoid stalling the Node.js event loop on every write.
 *
 * In production, this would write to a database or object store instead.
 */
export class AuditLogger {
  private readonly entries: AuditEntry[] = [];
  private readonly writeStream: fs.WriteStream | null;

  constructor(logDir?: string) {
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      const filePath = path.join(logDir, 'audit.ndjson');
      this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
      this.writeStream.on('error', (err) => {
        logger.error(`[AuditLogger] Write stream error: ${String(err)}`);
      });
    } else {
      this.writeStream = null;
    }
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);

    // Non-blocking write — the OS stream buffer absorbs bursts without
    // stalling the event loop. A false return signals back-pressure
    // (write buffer full); log a warning so operators can detect overload.
    const canContinue = this.writeStream?.write(JSON.stringify(full) + '\n');
    if (canContinue === false) {
      logger.warn('[AuditLogger] Write buffer full — back-pressure detected');
    }

    logger.debug(`[Audit] ${full.action} ${full.entity_type}:${full.entity_id}`);
    return full;
  }

  /** Flush and close the underlying file stream (call on graceful shutdown). */
  close(): void {
    this.writeStream?.end();
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
