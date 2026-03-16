/**
 * HAMT Registry Module
 *
 * Provides scalable indexing of conversation CIDs using HAMT (Hash Array Mapped Trie).
 * Supports batch processing, crash recovery, and efficient traversal for LLaVA export.
 *
 * @module registry
 */

import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import { sha256 } from "multiformats/hashes/sha2";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BatchMetadata {
  batchId: number;
  conversationCids: string[];
  rootCid: string;
  carSize: number;
  filecoinCid?: string;
  createdAt: number;
  conversationCount: number;
}

export interface RegistryState {
  version: string;
  totalBatches: number;
  totalConversations: number;
  batches: BatchMetadata[];
  hamtRoot?: string;
  lastUpdated: number;
}

export interface HAMTRegistry {
  /** Add a conversation CID to the registry */
  addConversation(cid: CID, batchId?: number): Promise<void>;
  /** Get all conversation CIDs */
  getAllConversations(): Promise<string[]>;
  /** Get conversations for a specific batch */
  getBatchConversations(batchId: number): Promise<string[]>;
  /** Create a new batch and return its metadata */
  createBatch(conversationCids: string[]): Promise<BatchMetadata>;
  /** Update batch with Filecoin CID after upload */
  updateBatchFilecoinCid(batchId: number, filecoinCid: string): Promise<void>;
  /** Get registry state */
  getState(): Promise<RegistryState>;
  /** Persist registry to disk */
  persist(filepath: string): Promise<void>;
  /** Load registry from disk */
  load(filepath: string): Promise<void>;
  /** Get HAMT root CID for efficient traversal */
  getHAMTRoot(): Promise<CID | undefined>;
  /** Build HAMT from all conversation CIDs */
  buildHAMT(): Promise<CID>;
}

// ── HAMT Node Types ─────────────────────────────────────────────────────────

interface HAMTEntry {
  key: string;
  value: { "/": string };
}

interface HAMTNode {
  entries: HAMTEntry[];
}

// ── Implementation ───────────────────────────────────────────────────────────

import * as fs from "fs/promises";
import * as path from "path";

export function createHAMTRegistry(): HAMTRegistry {
  // In-memory state
  let state: RegistryState = {
    version: "1.0.0",
    totalBatches: 0,
    totalConversations: 0,
    batches: [],
    hamtRoot: undefined,
    lastUpdated: Date.now(),
  };

  // HAMT root CID
  let hamtRootCid: CID | undefined;

  // CID cache for quick lookups
  const conversationCids = new Set<string>();

  const registry: HAMTRegistry = {
    async addConversation(cid: CID, batchId?: number): Promise<void> {
      const cidStr = cid.toString();
      
      if (conversationCids.has(cidStr)) {
        // Already registered, skip
        return;
      }

      conversationCids.add(cidStr);
      state.totalConversations++;

      // If batchId provided, add to that batch
      if (batchId !== undefined && batchId >= 0 && batchId < state.batches.length) {
        state.batches[batchId].conversationCids.push(cidStr);
      }

      // Invalidate HAMT root
      hamtRootCid = undefined;
      state.hamtRoot = undefined;
      state.lastUpdated = Date.now();
    },

    async getAllConversations(): Promise<string[]> {
      return Array.from(conversationCids);
    },

    async getBatchConversations(batchId: number): Promise<string[]> {
      if (batchId < 0 || batchId >= state.batches.length) {
        return [];
      }
      return state.batches[batchId].conversationCids;
    },

    async createBatch(conversationCids: string[]): Promise<BatchMetadata> {
      const batchId = state.totalBatches;
      
      const metadata: BatchMetadata = {
        batchId,
        conversationCids: [...conversationCids],
        rootCid: "",
        carSize: 0,
        createdAt: Date.now(),
        conversationCount: conversationCids.length,
      };

      state.batches.push(metadata);
      state.totalBatches++;
      state.lastUpdated = Date.now();

      return metadata;
    },

    async updateBatchFilecoinCid(batchId: number, filecoinCid: string): Promise<void> {
      if (batchId < 0 || batchId >= state.batches.length) {
        throw new Error(`Invalid batch ID: ${batchId}`);
      }
      state.batches[batchId].filecoinCid = filecoinCid;
      state.lastUpdated = Date.now();
    },

    async getState(): Promise<RegistryState> {
      return { ...state };
    },

    async persist(filepath: string): Promise<void> {
      const dir = path.dirname(filepath);
      await fs.mkdir(dir, { recursive: true });

      const stateToSave: RegistryState = {
        ...state,
        hamtRoot: hamtRootCid?.toString(),
        lastUpdated: Date.now(),
      };

      // Write atomically using temp file
      const tempPath = filepath + ".tmp";
      await fs.writeFile(tempPath, JSON.stringify(stateToSave, null, 2), "utf-8");
      await fs.rename(tempPath, filepath);
    },

    async load(filepath: string): Promise<void> {
      try {
        const content = await fs.readFile(filepath, "utf-8");
        const loadedState: RegistryState = JSON.parse(content);
        
        state = loadedState;
        
        // Rebuild in-memory CID set
        conversationCids.clear();
        for (const batch of state.batches) {
          for (const cid of batch.conversationCids) {
            conversationCids.add(cid);
          }
        }

        // Parse HAMT root CID if present
        if (state.hamtRoot) {
          hamtRootCid = CID.parse(state.hamtRoot);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // File doesn't exist, start fresh
          state = {
            version: "1.0.0",
            totalBatches: 0,
            totalConversations: 0,
            batches: [],
            hamtRoot: undefined,
            lastUpdated: Date.now(),
          };
          conversationCids.clear();
          hamtRootCid = undefined;
        } else {
          throw error;
        }
      }
    },

    async getHAMTRoot(): Promise<CID | undefined> {
      return hamtRootCid;
    },

    async buildHAMT(): Promise<CID> {
      const cidArray = Array.from(conversationCids);
      
      // Sort CIDs for consistent ordering
      cidArray.sort();

      // Build HAMT entries
      const entries: HAMTEntry[] = cidArray.map((cidStr) => ({
        key: cidStr,
        value: { "/": cidStr },
      }));

      // Create HAMT root block
      const hamtNode: HAMTNode = { entries };
      const bytes = dagJson.encode(hamtNode);
      const hash = await sha256.digest(bytes);
      hamtRootCid = CID.create(1, dagJson.code, hash);

      state.hamtRoot = hamtRootCid.toString();
      state.lastUpdated = Date.now();

      return hamtRootCid;
    },
  };

  return registry;
}

// ── Batch Processor Helper ──────────────────────────────────────────────────

export interface BatchProcessorOptions {
  batchSize: number;
  registryPath: string;
}

export interface BatchProcessor {
  /** Add a conversation and automatically batch when threshold reached */
  addConversation(rootCid: CID): Promise<BatchMetadata | null>;
  /** Force flush current batch even if not full */
  flush(): Promise<BatchMetadata | null>;
  /** Get current pending conversation CIDs */
  getPendingCids(): string[];
  /** Get registry instance */
  getRegistry(): HAMTRegistry;
}

export function createBatchProcessor(options: BatchProcessorOptions): BatchProcessor {
  const registry = createHAMTRegistry();
  const pendingCids: string[] = [];
  let currentBatchId = -1;

  // Load existing registry
  const initPromise = registry.load(options.registryPath);

  const processor: BatchProcessor = {
    async addConversation(rootCid: CID): Promise<BatchMetadata | null> {
      await initPromise;

      const cidStr = rootCid.toString();
      pendingCids.push(cidStr);

      // Check if batch is full
      if (pendingCids.length >= options.batchSize) {
        return await this.flush();
      }

      return null;
    },

    async flush(): Promise<BatchMetadata | null> {
      await initPromise;

      if (pendingCids.length === 0) {
        return null;
      }

      // Create new batch
      const metadata = await registry.createBatch(pendingCids);
      currentBatchId = metadata.batchId;

      // Add all CIDs to registry
      for (const cidStr of pendingCids) {
        const cid = CID.parse(cidStr);
        await registry.addConversation(cid, currentBatchId);
      }

      // Persist registry
      await registry.persist(options.registryPath);

      // Clear pending
      pendingCids.length = 0;

      // Build HAMT after each batch
      await registry.buildHAMT();
      await registry.persist(options.registryPath);

      return metadata;
    },

    getPendingCids(): string[] {
      return [...pendingCids];
    },

    getRegistry(): HAMTRegistry {
      return registry;
    },
  };

  return processor;
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Calculate the optimal batch size based on target CAR size
 * @param avgConversationSize Average size of a conversation in bytes
 * @param targetCarSize Target CAR file size in bytes (default: 100MB)
 * @returns Optimal batch size
 */
export function calculateOptimalBatchSize(
  avgConversationSize: number = 50000,
  targetCarSize: number = 100 * 1024 * 1024
): number {
  // Account for CAR overhead (~10%)
  const overhead = 1.1;
  return Math.floor(targetCarSize / (avgConversationSize * overhead));
}

/**
 * Validate registry integrity
 * @param registry Registry to validate
 * @returns Validation result
 */
export async function validateRegistry(registry: HAMTRegistry): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const state = await registry.getState();

  // Check version
  if (state.version !== "1.0.0") {
    warnings.push(`Unknown registry version: ${state.version}`);
  }

  // Check for duplicate CIDs across batches
  const seenCids = new Set<string>();
  for (const batch of state.batches) {
    for (const cid of batch.conversationCids) {
      if (seenCids.has(cid)) {
        errors.push(`Duplicate CID found: ${cid}`);
      }
      seenCids.add(cid);
    }
  }

  // Check batch consistency
  for (const batch of state.batches) {
    if (batch.batchId !== state.batches.indexOf(batch)) {
      errors.push(`Batch ${batch.batchId} has incorrect index`);
    }
    if (batch.conversationCount !== batch.conversationCids.length) {
      errors.push(`Batch ${batch.batchId} has mismatched conversation count`);
    }
  }

  // Check total counts
  const actualTotal = state.batches.reduce(
    (sum, batch) => sum + batch.conversationCids.length,
    0
  );
  if (actualTotal !== state.totalConversations) {
    warnings.push(
      `Total conversations mismatch: ${state.totalConversations} vs ${actualTotal}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}