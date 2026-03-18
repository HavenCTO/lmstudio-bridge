/**
 * V2 Registry Module
 *
 * Simple JSON file registry with batch metadata and provenance chain.
 * Replaces the HAMT registry with a straightforward batch tracker.
 *
 * @module registry
 */

import * as fs from "fs/promises";
import * as path from "path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BatchRecord {
  batchId: number;
  rootCid: string;
  filecoinCid: string;
  conversationCids: string[];
  conversationCount: number;
  carSize: number;
  createdAt: number;
  previousBatchCid: string | null;
}

export interface RegistryState {
  version: "2.0.0";
  totalBatches: number;
  totalConversations: number;
  batches: BatchRecord[];
  lastBatchCid: string | null;
  lastUpdated: number;
}

export interface Registry {
  addBatch(record: BatchRecord): Promise<void>;
  getBatch(batchId: number): Promise<BatchRecord | null>;
  getState(): Promise<RegistryState>;
  persist(filepath: string): Promise<void>;
  load(filepath: string): Promise<void>;
  /** Remove oldest batches, keeping only the most recent `maxBatches`. Returns removed records. */
  prune(maxBatches: number): Promise<BatchRecord[]>;
}

// ── Implementation ──────────────────────────────────────────────────────────

export function createRegistry(): Registry {
  let state: RegistryState = {
    version: "2.0.0",
    totalBatches: 0,
    totalConversations: 0,
    batches: [],
    lastBatchCid: null,
    lastUpdated: Date.now(),
  };

  const registry: Registry = {
    async addBatch(record: BatchRecord): Promise<void> {
      state.batches.push(record);
      state.totalBatches++;
      state.totalConversations += record.conversationCount;
      state.lastBatchCid = record.rootCid;
      state.lastUpdated = Date.now();
    },

    async getBatch(batchId: number): Promise<BatchRecord | null> {
      return state.batches.find((b) => b.batchId === batchId) ?? null;
    },

    async getState(): Promise<RegistryState> {
      return { ...state, batches: [...state.batches] };
    },

    async persist(filepath: string): Promise<void> {
      const dir = path.dirname(filepath);
      await fs.mkdir(dir, { recursive: true });

      const stateToSave: RegistryState = {
        ...state,
        lastUpdated: Date.now(),
      };

      // Write atomically using temp file + rename
      const tempPath = filepath + ".tmp";
      await fs.writeFile(tempPath, JSON.stringify(stateToSave, null, 2), "utf-8");
      await fs.rename(tempPath, filepath);
    },

    async prune(maxBatches: number): Promise<BatchRecord[]> {
      if (maxBatches <= 0 || state.batches.length <= maxBatches) {
        return [];
      }
      const removeCount = state.batches.length - maxBatches;
      const removed = state.batches.splice(0, removeCount);

      // Recalculate totals from remaining batches
      state.totalBatches = state.batches.length;
      state.totalConversations = state.batches.reduce(
        (sum, b) => sum + b.conversationCount,
        0
      );
      state.lastUpdated = Date.now();

      return removed;
    },

    async load(filepath: string): Promise<void> {
      try {
        const content = await fs.readFile(filepath, "utf-8");
        const loadedState = JSON.parse(content) as RegistryState;

        state = {
          version: "2.0.0",
          totalBatches: loadedState.totalBatches ?? 0,
          totalConversations: loadedState.totalConversations ?? 0,
          batches: loadedState.batches ?? [],
          lastBatchCid: loadedState.lastBatchCid ?? null,
          lastUpdated: loadedState.lastUpdated ?? Date.now(),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // File doesn't exist, start fresh
          state = {
            version: "2.0.0",
            totalBatches: 0,
            totalConversations: 0,
            batches: [],
            lastBatchCid: null,
            lastUpdated: Date.now(),
          };
        } else {
          throw error;
        }
      }
    },
  };

  return registry;
}
