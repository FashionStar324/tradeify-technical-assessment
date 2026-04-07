/**
 * Tracks seen execution IDs to prevent double-processing.
 * Uses a time-bounded LRU-like set: IDs older than `ttlMs` are evicted
 * periodically so memory stays bounded even under high throughput.
 */
export class EventDeduplicator {
  /** execution_id -> ingested timestamp (ms) */
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly evictionTimer: ReturnType<typeof setInterval>;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
    // Evict stale IDs every ttl/2
    this.evictionTimer = setInterval(() => this.evict(), ttlMs / 2);
    this.evictionTimer.unref(); // don't prevent process exit
  }

  /** Returns true if this is the first time the ID is seen (not a duplicate) */
  isNew(executionId: string): boolean {
    if (this.seen.has(executionId)) return false;
    this.seen.set(executionId, Date.now());
    return true;
  }

  stop(): void {
    clearInterval(this.evictionTimer);
  }

  private evict(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }
}
