/**
 * CAR File Extraction Module
 *
 * Handles parsing of CAR (Content Addressable aRchive) files,
 * extracting IPLD blocks, and reconstructing conversation data.
 */

import * as dagJson from "@ipld/dag-json";
import { CID } from "multiformats/cid";
import { CarReader } from "@ipld/car";
import {
  CarFileData,
  CarBlock,
  RecoveredConversation,
  RecoveredRequest,
  RecoveredResponse,
  RecoveredMetadata,
  RecoveredMessage,
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
 * Get block data as parsed JSON
 */
export function getBlockData<T>(blocks: Map<string, CarBlock>, cid: CID | string): T | null {
  const cidStr = typeof cid === "string" ? cid : cid.toString();
  const block = blocks.get(cidStr);
  
  if (!block) {
    console.warn(`[car] Block not found: ${cidStr}`);
    return null;
  }

  try {
    return dagJson.decode(block.bytes) as T;
  } catch (error) {
    console.warn(`[car] Failed to decode block ${cidStr}:`, error);
    return null;
  }
}

// ── IPLD Dereferencing ──────────────────────────────────────────────────────

/**
 * Recursively dereference IPLD links in a data structure
 */
export async function dereferenceIpldLinks<T>(
  data: unknown,
  blocks: Map<string, CarBlock>
): Promise<T> {
  if (data === null || data === undefined) {
    return data as T;
  }

  if (typeof data !== "object") {
    return data as T;
  }

  // Check for CID link format: { "/": "cid-string" }
  if (Object.keys(data).length === 1 && typeof (data as Record<string, unknown>).["/"] === "string") {
    const cidStr = (data as Record<string, string>).["/"];
    const cid = CID.parse(cidStr);
    const blockData = getBlockData(blocks, cid);
    
    if (blockData !== null) {
      return dereferenceIpldLinks<T>(blockData, blocks);
    }
    
    throw new Error(`Could not dereference CID: ${cidStr}`);
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    const result = [];
    for (const item of data) {
      result.push(await dereferenceIpldLinks(item, blocks));
    }
    return result as T;
  }

  // Recurse into objects
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = await dereferenceIpldLinks(value, blocks);
  }

  return result as T;
}

// ── Conversation Reconstruction ─────────────────────────────────────────────

/**
 * Reconstruct a complete conversation from CAR file blocks
 */
export async function extractConversation(
  carData: CarFileData
): Promise<RecoveredConversation> {
  console.log(`[car] Reconstructing conversation from blocks...`);

  // Get conversation root
  const conversationRoot = getBlockData<Record<string, unknown>>(
    carData.blocks,
    carData.rootCid
  );

  if (!conversationRoot) {
    throw new Error("Could not find conversation root block");
  }

  // Dereference all links
  const conversation = await dereferenceIpldLinks<RecoveredConversation>(
    conversationRoot,
    carData.blocks
  );

  console.log(`[car] Conversation reconstructed: model=${conversation.request.model}`);

  return conversation;
}

/**
 * Extract just the request portion of a conversation
 */
export async function extractRequest(
  carData: CarFileData
): Promise<RecoveredRequest> {
  const conversation = await extractConversation(carData);
  return conversation.request;
}

/**
 * Extract just the response portion of a conversation
 */
export async function extractResponse(
  carData: CarFileData
): Promise<RecoveredResponse> {
  const conversation = await extractConversation(carData);
  return conversation.response;
}

/**
 * Extract metadata from a conversation
 */
export async function extractMetadata(
  carData: CarFileData
): Promise<RecoveredMetadata> {
  const conversation = await extractConversation(carData);
  return conversation.metadata;
}

// ── Partial Extraction ──────────────────────────────────────────────────────

/**
 * Extract a specific message by index from a conversation
 */
export async function extractMessage(
  carData: CarFileData,
  messageIndex: number
): Promise<RecoveredMessage | null> {
  const conversation = await extractConversation(carData);
  
  if (messageIndex < 0 || messageIndex >= conversation.request.messages.length) {
    console.warn(`[car] Message index ${messageIndex} out of range`);
    return null;
  }

  return conversation.request.messages[messageIndex];
}

/**
 * Extract system prompt if present
 */
export async function extractSystemPrompt(
  carData: CarFileData
): Promise<string | null> {
  const conversation = await extractConversation(carData);
  
  if (conversation.request.messages.length > 0) {
    const firstMessage = conversation.request.messages[0];
    if (firstMessage.role === "system" && typeof firstMessage.content === "string") {
      return firstMessage.content;
    }
  }
  
  return null;
}

// ── Export Utilities ────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Output format */
  format?: "json" | "pretty-json" | "ndjson";
  /** Include raw CAR bytes */
  includeCar?: boolean;
  /** Include individual blocks */
  includeBlocks?: boolean;
}

/**
 * Export extracted conversation to various formats
 */
export function exportConversation(
  conversation: RecoveredConversation,
  options: ExportOptions = {}
): string {
  const format = options.format ?? "pretty-json";
  const exportData: Record<string, unknown> = {
    conversation,
  };

  if (options.includeCar) {
    // Note: CAR bytes would need to be passed separately
    console.warn("[car] includeCar option requires CAR bytes to be provided separately");
  }

  if (options.includeBlocks) {
    console.warn("[car] includeBlocks option requires block data to be provided separately");
  }

  switch (format) {
    case "json":
      return JSON.stringify(exportData);
    case "pretty-json":
      return JSON.stringify(exportData, null, 2);
    case "ndjson":
      return JSON.stringify(conversation.request) + "\n" + JSON.stringify(conversation.response);
    default:
      return JSON.stringify(exportData, null, 2);
  }
}

/**
 * Save extracted conversation to file
 */
import * as fs from "fs";
import * as path from "path";

export async function saveConversationToFile(
  carData: CarFileData,
  outputPath: string,
  options: ExportOptions = {}
): Promise<void> {
  const conversation = await extractConversation(carData);
  const content = exportConversation(conversation, options);

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(`[car] Saved conversation to: ${outputPath}`);
}

// ── Batch Extraction ────────────────────────────────────────────────────────

export interface BatchExtractionResult {
  cid: string;
  success: boolean;
  conversation?: RecoveredConversation;
  error?: string;
}

/**
 * Extract conversations from multiple CAR files
 */
export async function batchExtractConversations(
  carDatas: CarFileData[]
): Promise<BatchExtractionResult[]> {
  console.log(`[car] Extracting ${carDatas.length} conversations...`);

  const results: BatchExtractionResult[] = [];

  for (const carData of carDatas) {
    try {
      const conversation = await extractConversation(carData);
      results.push({
        cid: carData.rootCid.toString(),
        success: true,
        conversation,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        cid: carData.rootCid.toString(),
        success: false,
        error: errorMessage,
      });
      console.error(`[car] Failed to extract ${carData.rootCid}:`, errorMessage);
    }
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`[car] Extracted ${successCount}/${results.length} conversations successfully`);

  return results;
}
