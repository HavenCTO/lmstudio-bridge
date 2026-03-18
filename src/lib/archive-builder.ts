/**
 * Batch-Level IPLD Archive Builder
 *
 * Builds batch-level IPLD structures: one flat dag-cbor block per conversation,
 * one batch root block linking them all, assembled into a standard CARv1 file.
 *
 * Replaces: ipld-builder.ts (per-message DAG builder + custom CAR construction)
 *
 * @module archive-builder
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
// @ts-ignore — @ipld/car uses subpath exports
import { CarWriter } from "@ipld/car/writer";
// @ts-ignore — @ipld/car uses subpath exports
import { CarReader } from "@ipld/car/reader";

// ── Conversation Block (1 per conversation, stored as dag-cbor) ─────────────

export interface ArchiveConversation {
  id: string;                          // requestId
  timestamp: number;
  model: string;
  request: {
    messages: Array<{
      role: string;
      content: string | unknown[];
      name?: string;
    }>;
    parameters?: {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stream?: boolean;
      [key: string]: unknown;
    };
  };
  response: {
    id: string;
    model: string;
    created: number;
    choices: Array<{
      index: number;
      message: { role: string; content: string };
      finish_reason: string;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  encrypted?: boolean;
  encryptedPayload?: Uint8Array;       // if encrypted, replaces request+response
}

// ── Batch Root Block (1 per batch) ──────────────────────────────────────────

export interface BatchRoot {
  version: "2.0.0";
  schemaVersion: "conversation-archive/2.0.0";
  batchId: number;
  timestamp: number;
  previousBatch: CID | null;          // provenance chain link
  conversations: CID[];               // links to conversation blocks
  conversationCount: number;
  metadata: {
    shimVersion: string;
    captureWindow: {
      start: number;                   // earliest conversation timestamp
      end: number;                     // latest conversation timestamp
    };
    totalTokens: number;
    models: string[];                  // unique models in this batch
  };
}

// ── Build Result ────────────────────────────────────────────────────────────

export interface ArchiveResult {
  carBytes: Uint8Array;                // complete CARv1 file
  rootCid: CID;                        // CID of the BatchRoot block
  conversationCids: Map<string, CID>;  // requestId → conversation CID
  blockCount: number;
  totalSize: number;
}

// ── Helper: encode data to dag-cbor and compute CID ─────────────────────────

async function encodeBlock(data: unknown): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagCbor.encode(data);
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, dagCbor.code, hash);
  return { cid, bytes };
}

// ── Build Functions ─────────────────────────────────────────────────────────

/**
 * Build a complete batch archive from raw conversations.
 *
 * 1. For each conversation: dag-cbor encode → SHA-256 → CID → store block
 * 2. Build batch root with CID links to all conversations
 * 3. Assemble all blocks into a standard CARv1 file via @ipld/car
 *
 * @returns ArchiveResult with CAR bytes, root CID, and per-conversation CIDs
 */
export async function buildBatchArchive(
  conversations: ArchiveConversation[],
  batchId: number,
  shimVersion: string,
  previousBatchCid: CID | null
): Promise<ArchiveResult> {
  // Collect all blocks: CID → bytes
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  const conversationCids = new Map<string, CID>();
  const conversationCidArray: CID[] = [];

  // 1. Encode each conversation as a flat dag-cbor block
  for (const conv of conversations) {
    const { cid, bytes } = await encodeBlock(conv);
    blocks.set(cid.toString(), { cid, bytes });
    conversationCids.set(conv.id, cid);
    conversationCidArray.push(cid);
  }

  // 2. Compute metadata
  const timestamps = conversations.map((c) => c.timestamp);
  const models = [...new Set(conversations.map((c) => c.model))];
  const totalTokens = conversations.reduce((sum, c) => {
    return sum + (c.response.usage?.total_tokens ?? 0);
  }, 0);

  // 3. Build batch root
  const batchRoot: BatchRoot = {
    version: "2.0.0",
    schemaVersion: "conversation-archive/2.0.0",
    batchId,
    timestamp: Date.now(),
    previousBatch: previousBatchCid,
    conversations: conversationCidArray,
    conversationCount: conversations.length,
    metadata: {
      shimVersion,
      captureWindow: {
        start: timestamps.length > 0 ? Math.min(...timestamps) : 0,
        end: timestamps.length > 0 ? Math.max(...timestamps) : 0,
      },
      totalTokens,
      models,
    },
  };

  const { cid: rootCid, bytes: rootBytes } = await encodeBlock(batchRoot);
  blocks.set(rootCid.toString(), { cid: rootCid, bytes: rootBytes });

  // 4. Assemble CARv1 using @ipld/car
  const carBytes = await assembleCAR(rootCid, blocks);

  // 5. Compute total size
  let totalSize = 0;
  for (const block of blocks.values()) {
    totalSize += block.bytes.length;
  }

  return {
    carBytes,
    rootCid,
    conversationCids,
    blockCount: blocks.size,
    totalSize,
  };
}

/**
 * Assemble blocks into a standard CARv1 file.
 */
async function assembleCAR(
  rootCid: CID,
  blocks: Map<string, { cid: CID; bytes: Uint8Array }>
): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([rootCid]);

  // Collect output chunks
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) {
      chunks.push(chunk);
    }
  })();

  // Write all blocks
  for (const { cid, bytes } of blocks.values()) {
    await writer.put({ cid, bytes });
  }
  await writer.close();

  // Wait for output collection to finish
  await collectPromise;

  // Concatenate chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// ── Verify Function ─────────────────────────────────────────────────────────

/**
 * Verify a CAR file's integrity.
 * Re-hashes every block and checks CID matches.
 * Verifies batch root links match contained conversation blocks.
 *
 * @returns { valid: boolean, errors: string[] }
 */
export async function verifyArchive(
  carBytes: Uint8Array
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();

    if (roots.length === 0) {
      errors.push("CAR file has no roots");
      return { valid: false, errors };
    }

    // Verify each block's CID matches its content hash
    for await (const block of reader.blocks()) {
      const hash = await sha256.digest(block.bytes);
      const expectedCid = CID.create(1, dagCbor.code, hash) as unknown as CID;

      if (!block.cid.equals(expectedCid)) {
        errors.push(
          `Block CID mismatch: expected ${String(expectedCid)}, got ${String(block.cid)}`
        );
      }
    }

    // Verify batch root links
    const rootCid = roots[0];
    const rootBlock = await reader.get(rootCid);
    if (!rootBlock) {
      errors.push(`Root block not found: ${rootCid.toString()}`);
    } else {
      const root = dagCbor.decode(rootBlock.bytes) as Record<string, any>;

      if (root.conversations && Array.isArray(root.conversations)) {
        for (const convCid of root.conversations as CID[]) {
          const convBlock = await reader.get(convCid);
          if (!convBlock) {
            errors.push(
              `Conversation block referenced by root not found: ${convCid.toString()}`
            );
          }
        }
      }
    }
  } catch (err) {
    errors.push(`CAR parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { valid: errors.length === 0, errors };
}

// ── Read Function ───────────────────────────────────────────────────────────

/**
 * Extract all conversation blocks from a CAR file.
 * Returns the batch root and a map of CID → decoded ArchiveConversation.
 * Used by the exporter.
 */
export async function readArchive(
  carBytes: Uint8Array
): Promise<{
  root: BatchRoot;
  rootCid: CID;
  conversations: Map<string, ArchiveConversation>;  // CID string → conversation
}> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();

  if (roots.length === 0) {
    throw new Error("CAR file has no roots");
  }

  const rootCid = roots[0];
  const rootBlock = await reader.get(rootCid);
  if (!rootBlock) {
    throw new Error(`Root block not found: ${rootCid.toString()}`);
  }

  const rootDecoded = dagCbor.decode(rootBlock.bytes) as Record<string, any>;
  const root = rootDecoded as unknown as BatchRoot;
  const conversations = new Map<string, ArchiveConversation>();

  // Read each conversation block referenced by the root
  const convCids = rootDecoded.conversations as CID[] | undefined;
  if (convCids && Array.isArray(convCids)) {
    for (const cid of convCids) {
      const convBlock = await reader.get(cid);
      if (convBlock) {
        const conv = dagCbor.decode(convBlock.bytes) as Record<string, any> as unknown as ArchiveConversation;
        conversations.set(cid.toString(), conv);
      }
    }
  }

  return { root, rootCid, conversations };
}
