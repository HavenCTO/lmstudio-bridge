/**
 * V2 Registry Tests
 *
 * Tests for the simplified JSON file registry.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createRegistry, BatchRecord } from "../src/lib/registry";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function makeBatchRecord(batchId: number, convCount: number = 3): BatchRecord {
  return {
    batchId,
    rootCid: `bafyroot${batchId}`,
    filecoinCid: `bafyfilecoin${batchId}`,
    conversationCids: Array.from({ length: convCount }, (_, i) => `bafyconv${batchId}-${i}`),
    conversationCount: convCount,
    carSize: 1024 * (batchId + 1),
    createdAt: Date.now(),
    previousBatchCid: batchId > 0 ? `bafyroot${batchId - 1}` : null,
  };
}

describe("v2 registry", () => {
  it("should create empty registry with correct defaults", async () => {
    const registry = createRegistry();
    const state = await registry.getState();

    expect(state.version).toBe("2.0.0");
    expect(state.totalBatches).toBe(0);
    expect(state.totalConversations).toBe(0);
    expect(state.batches).toHaveLength(0);
    expect(state.lastBatchCid).toBeNull();
  });

  it("should add batches and update totals", async () => {
    const registry = createRegistry();

    await registry.addBatch(makeBatchRecord(0, 5));
    let state = await registry.getState();
    expect(state.totalBatches).toBe(1);
    expect(state.totalConversations).toBe(5);
    expect(state.lastBatchCid).toBe("bafyroot0");

    await registry.addBatch(makeBatchRecord(1, 3));
    state = await registry.getState();
    expect(state.totalBatches).toBe(2);
    expect(state.totalConversations).toBe(8);
    expect(state.lastBatchCid).toBe("bafyroot1");
  });

  it("should get batch by ID", async () => {
    const registry = createRegistry();
    await registry.addBatch(makeBatchRecord(42, 7));

    const batch = await registry.getBatch(42);
    expect(batch).not.toBeNull();
    expect(batch!.batchId).toBe(42);
    expect(batch!.conversationCount).toBe(7);
    expect(batch!.rootCid).toBe("bafyroot42");
  });

  it("should return null for non-existent batch", async () => {
    const registry = createRegistry();
    const batch = await registry.getBatch(999);
    expect(batch).toBeNull();
  });

  it("should persist and load registry", async () => {
    const filePath = path.join(tmpDir, "registry.json");
    const registry = createRegistry();

    await registry.addBatch(makeBatchRecord(0, 5));
    await registry.addBatch(makeBatchRecord(1, 3));
    await registry.persist(filePath);

    // Verify file exists
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.totalBatches).toBe(2);

    // Load into new registry
    const registry2 = createRegistry();
    await registry2.load(filePath);
    const state = await registry2.getState();

    expect(state.totalBatches).toBe(2);
    expect(state.totalConversations).toBe(8);
    expect(state.batches).toHaveLength(2);
    expect(state.lastBatchCid).toBe("bafyroot1");
  });

  it("should handle load from non-existent file (start fresh)", async () => {
    const registry = createRegistry();
    await registry.load(path.join(tmpDir, "nonexistent.json"));

    const state = await registry.getState();
    expect(state.totalBatches).toBe(0);
    expect(state.totalConversations).toBe(0);
  });

  it("should track previousBatchCid in provenance chain", async () => {
    const registry = createRegistry();

    const batch0 = makeBatchRecord(0, 2);
    batch0.previousBatchCid = null;
    await registry.addBatch(batch0);

    const batch1 = makeBatchRecord(1, 3);
    batch1.previousBatchCid = "bafyroot0";
    await registry.addBatch(batch1);

    const state = await registry.getState();
    expect(state.batches[0].previousBatchCid).toBeNull();
    expect(state.batches[1].previousBatchCid).toBe("bafyroot0");
  });

  it("should return a copy of state (not a reference)", async () => {
    const registry = createRegistry();
    await registry.addBatch(makeBatchRecord(0, 2));

    const state1 = await registry.getState();
    const state2 = await registry.getState();

    // Mutating state1 should not affect state2
    state1.batches.push(makeBatchRecord(99));
    expect(state2.batches).toHaveLength(1);
  });

  it("should persist atomically (temp file + rename)", async () => {
    const filePath = path.join(tmpDir, "registry.json");
    const registry = createRegistry();
    await registry.addBatch(makeBatchRecord(0));
    await registry.persist(filePath);

    // Temp file should not exist after persist
    const tmpFile = filePath + ".tmp";
    await expect(fs.access(tmpFile)).rejects.toThrow();

    // Main file should exist
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });
});
