/**
 * Unit tests for FlushQueue — the serial background flush processor.
 */

import { FlushQueue, FlushJob, FlushQueueStats } from "../src/lib/flush-queue";

// Helper to create a minimal conversation ref
function makeConv(id: string) {
  return { requestId: id };
}

// Helper to wait for queue to settle
async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FlushQueue", () => {
  // ── Basic enqueue / execute ──────────────────────────────────────────

  it("should execute a single enqueued job", async () => {
    const executed: FlushJob[] = [];
    const queue = new FlushQueue(async (job) => {
      executed.push(job);
    });

    queue.enqueue([makeConv("r1"), makeConv("r2")]);
    await queue.drain(5000);

    expect(executed).toHaveLength(1);
    expect(executed[0].conversations).toHaveLength(2);
    expect(executed[0].conversations[0].requestId).toBe("r1");
    expect(executed[0].retryCount).toBe(0);
  });

  it("should process multiple jobs serially in FIFO order", async () => {
    const order: number[] = [];
    const queue = new FlushQueue(async (job) => {
      order.push(job.batchTimestamp);
      // Simulate some async work
      await new Promise((r) => setTimeout(r, 10));
    });

    queue.enqueue([makeConv("a")], 100);
    queue.enqueue([makeConv("b")], 200);
    queue.enqueue([makeConv("c")], 300);

    await queue.drain(5000);

    expect(order).toEqual([100, 200, 300]);
  });

  it("should never run two jobs concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const queue = new FlushQueue(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    });

    queue.enqueue([makeConv("a")]);
    queue.enqueue([makeConv("b")]);
    queue.enqueue([makeConv("c")]);

    await queue.drain(5000);

    expect(maxConcurrent).toBe(1);
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it("should track completed count", async () => {
    const queue = new FlushQueue(async () => {});

    queue.enqueue([makeConv("a")]);
    queue.enqueue([makeConv("b")]);

    await queue.drain(5000);

    const stats = queue.getStats();
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.activeJob).toBe(false);
  });

  it("should report pending count before drain", async () => {
    let resolve1: () => void;
    const blocker = new Promise<void>((r) => { resolve1 = r; });

    const queue = new FlushQueue(async () => {
      await blocker;
    });

    queue.enqueue([makeConv("a")]);
    queue.enqueue([makeConv("b")]);
    queue.enqueue([makeConv("c")]);

    // First job is active, two are pending
    await settle(20);
    const stats = queue.getStats();
    expect(stats.activeJob).toBe(true);
    expect(stats.pending).toBe(2);

    resolve1!();
    await queue.drain(5000);
  });

  // ── Retry logic ──────────────────────────────────────────────────────

  it("should retry failed jobs up to maxRetries", async () => {
    let attempts = 0;
    const queue = new FlushQueue(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient failure");
      },
      { maxRetries: 3, retryDelayMs: 10, maxRetryDelayMs: 50 }
    );

    queue.enqueue([makeConv("a")]);
    await queue.drain(10000);

    expect(attempts).toBe(3); // 1 initial + 2 retries, succeeds on 3rd
    const stats = queue.getStats();
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("should dead-letter after maxRetries exhausted", async () => {
    let attempts = 0;
    const queue = new FlushQueue(
      async () => {
        attempts++;
        throw new Error("permanent failure");
      },
      { maxRetries: 2, retryDelayMs: 10, maxRetryDelayMs: 50 }
    );

    const deadLettered: FlushJob[] = [];
    queue.onComplete((job, error) => {
      if (error) deadLettered.push(job);
    });

    queue.enqueue([makeConv("a")]);
    await queue.drain(10000);

    // 1 initial + 2 retries = 3 total attempts
    expect(attempts).toBe(3);
    const stats = queue.getStats();
    expect(stats.failed).toBe(1);
    expect(stats.deadLettered).toBe(1);
    expect(stats.completed).toBe(0);
    expect(deadLettered).toHaveLength(1);
  });

  it("should use exponential backoff on retries", async () => {
    const timestamps: number[] = [];
    let attempts = 0;

    const queue = new FlushQueue(
      async () => {
        timestamps.push(Date.now());
        attempts++;
        if (attempts <= 2) throw new Error("fail");
      },
      { maxRetries: 3, retryDelayMs: 50, maxRetryDelayMs: 500 }
    );

    queue.enqueue([makeConv("a")]);
    await queue.drain(10000);

    expect(timestamps).toHaveLength(3);
    // First retry delay should be ~50ms (retryDelayMs * 2^0)
    const delay1 = timestamps[1] - timestamps[0];
    // Second retry delay should be ~100ms (retryDelayMs * 2^1)
    const delay2 = timestamps[2] - timestamps[1];

    // Allow generous tolerance for CI
    expect(delay1).toBeGreaterThanOrEqual(30);
    expect(delay2).toBeGreaterThanOrEqual(60);
    expect(delay2).toBeGreaterThan(delay1 * 0.8); // second delay should be longer
  });

  // ── Backpressure ─────────────────────────────────────────────────────

  it("should invoke backpressure callback when queue is full", async () => {
    let backpressureFired = false;
    let resolve1: () => void;
    const blocker = new Promise<void>((r) => { resolve1 = r; });

    const queue = new FlushQueue(
      async () => { await blocker; },
      {
        maxQueueDepth: 3,
        backpressureCallback: () => { backpressureFired = true; },
      }
    );

    // First job starts executing, next 3 go into queue
    queue.enqueue([makeConv("a")]);
    queue.enqueue([makeConv("b")]);
    queue.enqueue([makeConv("c")]);

    expect(backpressureFired).toBe(false);

    // This 4th enqueue pushes queue to depth 3 (since first is active)
    queue.enqueue([makeConv("d")]);

    expect(backpressureFired).toBe(true);

    resolve1!();
    await queue.drain(5000);
  });

  // ── Recovery jobs ────────────────────────────────────────────────────

  it("should enqueue recovery jobs with carPath", async () => {
    const executed: FlushJob[] = [];
    const queue = new FlushQueue(async (job) => {
      executed.push(job);
    });

    queue.enqueueRecovery("/data/batch-123/merged.car", 123);
    await queue.drain(5000);

    expect(executed).toHaveLength(1);
    expect(executed[0].recoveryCarPath).toBe("/data/batch-123/merged.car");
    expect(executed[0].batchTimestamp).toBe(123);
    expect(executed[0].conversations).toHaveLength(0);
  });

  // ── Drain ────────────────────────────────────────────────────────────

  it("should resolve immediately if queue is empty", async () => {
    const queue = new FlushQueue(async () => {});
    const start = Date.now();
    await queue.drain(5000);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("should timeout if jobs take too long", async () => {
    const queue = new FlushQueue(async () => {
      await new Promise((r) => setTimeout(r, 5000));
    });

    queue.enqueue([makeConv("a")]);

    const start = Date.now();
    await queue.drain(300);
    const elapsed = Date.now() - start;

    // Should have timed out around 300ms, not waited 5000ms
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  // ── onComplete callback ──────────────────────────────────────────────

  it("should fire onComplete for successful jobs", async () => {
    const completed: FlushJob[] = [];
    const queue = new FlushQueue(async () => {});

    queue.onComplete((job, error) => {
      if (!error) completed.push(job);
    });

    queue.enqueue([makeConv("a")]);
    queue.enqueue([makeConv("b")]);
    await queue.drain(5000);

    expect(completed).toHaveLength(2);
  });

  it("should fire onComplete with error for dead-lettered jobs", async () => {
    const errors: Error[] = [];
    const queue = new FlushQueue(
      async () => { throw new Error("boom"); },
      { maxRetries: 0, retryDelayMs: 10 }
    );

    queue.onComplete((job, error) => {
      if (error) errors.push(error);
    });

    queue.enqueue([makeConv("a")]);
    await queue.drain(5000);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  // ── Properties ───────────────────────────────────────────────────────

  it("should expose pending and isProcessing", async () => {
    let resolve1: () => void;
    const blocker = new Promise<void>((r) => { resolve1 = r; });

    const queue = new FlushQueue(async () => { await blocker; });

    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);

    queue.enqueue([makeConv("a")]);
    queue.enqueue([makeConv("b")]);

    await settle(20);

    expect(queue.isProcessing).toBe(true);
    expect(queue.pending).toBe(1); // one active, one pending

    resolve1!();
    await queue.drain(5000);

    expect(queue.isProcessing).toBe(false);
    expect(queue.pending).toBe(0);
  });
});
