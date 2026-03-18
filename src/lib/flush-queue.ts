/**
 * Flush Queue Module
 *
 * Encapsulates serial background flush processing with retry, backpressure,
 * and graceful drain for the upload middleware. Jobs are processed one at a
 * time in FIFO order so that Filecoin uploads never run concurrently.
 *
 * @module flush-queue
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface FlushJob {
  /** Conversations to flush (snapshot from batchState) */
  conversations: PendingConversationRef[];
  /** Timestamp used as the batch directory name */
  batchTimestamp: number;
  /** Number of times this job has been retried */
  retryCount: number;
  /** If set, this is a recovery job — the merged CAR already exists on disk */
  recoveryCarPath?: string;
}

/**
 * Minimal reference to a pending conversation — the queue doesn't need to
 * know the full PendingConversation shape, only enough to pass it through
 * to the flush executor.
 */
export interface PendingConversationRef {
  requestId: string;
  [key: string]: unknown;
}

export interface FlushQueueStats {
  pending: number;
  completed: number;
  failed: number;
  deadLettered: number;
  activeJob: boolean;
}

export interface FlushQueueConfig {
  /** Maximum retry attempts per job (default: 3) */
  maxRetries?: number;
  /** Base delay between retries in ms (default: 5000) */
  retryDelayMs?: number;
  /** Maximum retry delay in ms — caps exponential backoff (default: 60000) */
  maxRetryDelayMs?: number;
  /** Maximum queue depth before backpressure fires (default: 50) */
  maxQueueDepth?: number;
  /** Called when queue depth exceeds maxQueueDepth */
  backpressureCallback?: () => void;
}

export type FlushExecutor = (job: FlushJob) => Promise<void>;
export type CompleteCallback = (job: FlushJob, error?: Error) => void;

// ── Implementation ──────────────────────────────────────────────────────────

export class FlushQueue {
  private queue: FlushJob[] = [];
  private activeFlush: Promise<void> | null = null;
  private stats = { completed: 0, failed: 0, deadLettered: 0 };
  private executor: FlushExecutor;
  private config: Required<FlushQueueConfig>;
  private onCompleteCallbacks: CompleteCallback[] = [];

  constructor(executor: FlushExecutor, config?: FlushQueueConfig) {
    this.executor = executor;
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      retryDelayMs: config?.retryDelayMs ?? 5000,
      maxRetryDelayMs: config?.maxRetryDelayMs ?? 60000,
      maxQueueDepth: config?.maxQueueDepth ?? 50,
      backpressureCallback: config?.backpressureCallback ?? (() => {}),
    };
  }

  /** Enqueue a new flush job */
  enqueue(conversations: PendingConversationRef[], batchTimestamp?: number): void {
    const job: FlushJob = {
      conversations,
      batchTimestamp: batchTimestamp ?? Date.now(),
      retryCount: 0,
    };
    this.pushJob(job);
  }

  /** Enqueue a recovery job (merged CAR already on disk, just needs upload + registry) */
  enqueueRecovery(mergedCarPath: string, batchTimestamp: number): void {
    const job: FlushJob = {
      conversations: [],
      batchTimestamp,
      retryCount: 0,
      recoveryCarPath: mergedCarPath,
    };
    this.pushJob(job);
  }

  /** Register a callback invoked after each job completes (success or final failure) */
  onComplete(callback: CompleteCallback): void {
    this.onCompleteCallbacks.push(callback);
  }

  /** Get queue statistics */
  getStats(): FlushQueueStats {
    return {
      pending: this.queue.length,
      completed: this.stats.completed,
      failed: this.stats.failed,
      deadLettered: this.stats.deadLettered,
      activeJob: this.activeFlush !== null,
    };
  }

  /** Wait for all pending jobs to complete (with timeout) */
  async drain(timeoutMs = 30000): Promise<void> {
    if (!this.activeFlush && this.queue.length === 0) return;

    console.log(`[flush-queue] draining ${this.queue.length} pending flush(es)...`);

    const deadline = Date.now() + timeoutMs;
    while ((this.activeFlush || this.queue.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (this.activeFlush || this.queue.length > 0) {
      console.warn(
        `[flush-queue] drain timeout — ${this.queue.length} flush(es) still pending`
      );
    } else {
      console.log(`[flush-queue] drain complete`);
    }
  }

  /** Number of jobs waiting (not including the active one) */
  get pending(): number {
    return this.queue.length;
  }

  /** Whether a job is currently being processed */
  get isProcessing(): boolean {
    return this.activeFlush !== null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private pushJob(job: FlushJob): void {
    this.queue.push(job);

    // Backpressure check
    if (this.queue.length >= this.config.maxQueueDepth) {
      console.warn(
        `[flush-queue] backpressure: queue depth ${this.queue.length} >= ${this.config.maxQueueDepth}`
      );
      this.config.backpressureCallback();
    }

    this.drainNext();
  }

  private drainNext(): void {
    if (this.activeFlush || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.activeFlush = this.processJob(job).finally(() => {
      this.activeFlush = null;
      this.drainNext();
    });
  }

  private async processJob(job: FlushJob): Promise<void> {
    try {
      await this.executor(job);
      this.stats.completed++;
      this.notifyComplete(job);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (job.retryCount < this.config.maxRetries) {
        // Re-enqueue with backoff
        const delay = Math.min(
          this.config.retryDelayMs * Math.pow(2, job.retryCount),
          this.config.maxRetryDelayMs
        );
        console.error(
          `[flush-queue] job failed (attempt ${job.retryCount + 1}/${this.config.maxRetries}), ` +
          `retrying in ${delay}ms: ${error.message}`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));

        // Re-enqueue at front of queue with incremented retry count
        const retryJob: FlushJob = { ...job, retryCount: job.retryCount + 1 };
        this.queue.unshift(retryJob);
      } else {
        // Dead-letter — give up on this job
        this.stats.failed++;
        this.stats.deadLettered++;
        console.error(
          `[flush-queue] job dead-lettered after ${job.retryCount + 1} attempts ` +
          `(batch ${job.batchTimestamp}, ${job.conversations.length} conversations): ${error.message}`
        );
        this.notifyComplete(job, error);
      }
    }
  }

  private notifyComplete(job: FlushJob, error?: Error): void {
    for (const cb of this.onCompleteCallbacks) {
      try {
        cb(job, error);
      } catch {
        // Swallow callback errors
      }
    }
  }
}
