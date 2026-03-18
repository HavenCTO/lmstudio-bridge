/**
 * CAR File Extraction Module — V2 Architecture
 *
 * Reads standard CARv1 files containing v2 batch archives.
 * Each CAR has one batch root block + N flat conversation blocks (dag-cbor).
 * No IPLD link dereferencing needed — conversations are self-contained.
 */

import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { CarReader } from "@ipld/car";
import * as fs from "fs";
import * as path from "path";
import {
  CarFileData,
  CarBlock,
  RecoveredConversation,
  RecoveredBatchRoot,
  BatchExtractionResult,
} from "../types";

// ── CAR File Parsing ────────────────────────────────────────────────────────

/**
 * Parse a CAR file and extract all blocks
 */
export async function parseCarFile(carBytes: Uint8Array): Promise<CarFileData> {
  console.log(`[car] Parsing CAR file (${carBytes.length} bytes)...`);

  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();

  if (roots.length === 0) {
    throw new Error("CAR file has no root CIDs");
  }

  const rootCid = roots[0];
  const blocks = new Map<string, CarBlock>();

  let blockCount = 0;
  for await (const block of reader.blocks()) {
    const cidStr = block.cid.toString();
    blocks.set(cidStr, {
      cid: block.cid,
      bytes: block.bytes,
    });
    blockCount++;
  }

  console.log(`[car] Extracted ${blockCount} blocks, root CID: ${rootCid}`);

  return {
    rootCid,
    blocks,
  };
}

/**
 * Decode a dag-cbor block
 */
export function decodeBlock<T>(block: CarBlock): T {
  return dagCbor.decode(block.bytes) as unknown as T;
}

// ── V2 Batch Extraction ─────────────────────────────────────────────────────

/**
 * Extract a complete v2 batch from a CAR file.
 *
 * V2 format: one batch root block + N flat conversation blocks.
 * No DAG traversal needed — each conversation is a single self-contained block.
 */
export async function extractBatch(
  carData: CarFileData
): Promise<BatchExtractionResult> {
  console.log(`[car] Extracting v2 batch from CAR...`);

  // Decode the batch root
  const rootBlock = carData.blocks.get(carData.rootCid.toString());
  if (!rootBlock) {
    throw new Error("Batch root block not found in CAR");
  }

  const batchRoot = decodeBlock<RecoveredBatchRoot>(rootBlock);

  if (!batchRoot.version || !batchRoot.conversations) {
    throw new Error("Invalid v2 batch root: missing version or conversations field");
  }

  console.log(`[car] Batch v${batchRoot.version}, ${batchRoot.conversationCount} conversations`);

  // Extract each conversation block referenced by the root
  const conversations = new Map<string, RecoveredConversation>();

  for (const convCid of batchRoot.conversations) {
    const cidStr = convCid.toString();
    const convBlock = carData.blocks.get(cidStr);

    if (!convBlock) {
      console.warn(`[car] Conversation block not found: ${cidStr}`);
      continue;
    }

    const conversation = decodeBlock<RecoveredConversation>(convBlock);
    conversations.set(cidStr, conversation);
  }

  console.log(`[car] Extracted ${conversations.size} conversations from batch`);

  return {
    batchRoot,
    rootCid: carData.rootCid,
    conversations,
    blockCount: carData.blocks.size,
  };
}

/**
 * Extract a single conversation from a batch CAR by its CID
 */
export async function extractConversationByCid(
  carData: CarFileData,
  conversationCid: string
): Promise<RecoveredConversation | null> {
  const block = carData.blocks.get(conversationCid);
  if (!block) {
    console.warn(`[car] Conversation block not found: ${conversationCid}`);
    return null;
  }

  return decodeBlock<RecoveredConversation>(block);
}

// ── Export Utilities ────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Output format */
  format?: "json" | "pretty-json" | "ndjson";
}

/**
 * Export a recovered conversation to string
 */
export function exportConversation(
  conversation: RecoveredConversation,
  options: ExportOptions = {}
): string {
  const format = options.format ?? "pretty-json";

  switch (format) {
    case "json":
      return JSON.stringify(conversation);
    case "pretty-json":
      return JSON.stringify(conversation, null, 2);
    case "ndjson":
      return JSON.stringify(conversation);
    default:
      return JSON.stringify(conversation, null, 2);
  }
}

/**
 * Export an entire batch to string (all conversations)
 */
export function exportBatch(
  result: BatchExtractionResult,
  options: ExportOptions = {}
): string {
  const format = options.format ?? "pretty-json";

  const output = {
    batchId: result.batchRoot.batchId,
    version: result.batchRoot.version,
    rootCid: result.rootCid.toString(),
    conversationCount: result.conversations.size,
    metadata: result.batchRoot.metadata,
    previousBatch: result.batchRoot.previousBatch?.toString() ?? null,
    conversations: [...result.conversations.entries()].map(([cid, conv]) => ({
      cid,
      ...conv,
    })),
  };

  switch (format) {
    case "json":
      return JSON.stringify(output);
    case "pretty-json":
      return JSON.stringify(output, null, 2);
    case "ndjson":
      return [...result.conversations.values()]
        .map((conv) => JSON.stringify(conv))
        .join("\n") + "\n";
    default:
      return JSON.stringify(output, null, 2);
  }
}

/**
 * Save extracted batch to file
 */
export async function saveBatchToFile(
  result: BatchExtractionResult,
  outputPath: string,
  options: ExportOptions = {}
): Promise<void> {
  const content = exportBatch(result, options);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(`[car] Saved batch to: ${outputPath}`);
}

/**
 * Save individual conversations from a batch to separate files
 */
export async function saveConversationsToDir(
  result: BatchExtractionResult,
  outputDir: string,
  options: ExportOptions = {}
): Promise<string[]> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const savedPaths: string[] = [];

  for (const [cidStr, conv] of result.conversations) {
    const filename = `${conv.id || cidStr}.json`;
    const filePath = path.join(outputDir, filename);
    const content = exportConversation(conv, options);
    fs.writeFileSync(filePath, content, "utf-8");
    savedPaths.push(filePath);
  }

  console.log(`[car] Saved ${savedPaths.length} conversations to: ${outputDir}`);
  return savedPaths;
}
