/**
 * Recovery Orchestrator Module — V2 Architecture
 *
 * Coordinates the complete data recovery workflow:
 * 1. Retrieve CAR files from IPFS/Synapse or local disk
 * 2. Extract v2 batch (flat dag-cbor conversation blocks)
 * 3. Decrypt TACo-encrypted payloads (if applicable)
 * 4. Save recovered data to output directory
 */

import * as fs from "fs";
import * as path from "path";
import {
  retrieveFromGateway,
  loadLocalCarFile,
} from "./retriever";
import {
  parseCarFile,
  extractBatch,
  saveBatchToFile,
  saveConversationsToDir,
} from "./car-extractor";
import {
  decryptHybridData,
  isDataEncrypted,
  TacoDecryptionOptions,
} from "./decryptor";
import {
  RecoveredConversation,
  RecoveredBatchRoot,
  BatchExtractionResult,
} from "../types";

// ── Recovery Pipeline ───────────────────────────────────────────────────────

export interface RecoveryPipelineResult {
  /** The original CID or file path */
  source: string;
  /** Whether recovery was successful */
  success: boolean;
  /** Extracted batch result */
  batch?: BatchExtractionResult;
  /** Path to saved output */
  outputPath?: string;
  /** Individual conversation output paths */
  conversationPaths?: string[];
  /** Error message if failed */
  error?: string;
  /** Warnings during recovery */
  warnings?: string[];
}

export interface RecoveryPipelineOptions {
  /** Output directory for recovered data */
  outputDir: string;
  /** IPFS gateway URL (optional) */
  ipfsGateway?: string;
  /** Skip decryption step */
  skipDecryption?: boolean;
  /** TACo decryption options (required if encrypted) */
  tacoOptions?: TacoDecryptionOptions;
  /** Verbose logging */
  verbose?: boolean;
  /** Save raw CAR files */
  saveCarFiles?: boolean;
  /** Save individual conversations as separate files */
  splitConversations?: boolean;
  /** Output format */
  format?: "json" | "pretty-json" | "ndjson";
}

/**
 * Recover a batch from a CID or local CAR file.
 *
 * V2 batches contain multiple conversations in a single CAR.
 * Each conversation is a flat dag-cbor block — no DAG traversal needed.
 */
export async function recoverBatch(
  input: { type: "cid"; cid: string } | { type: "local"; filePath: string },
  options: RecoveryPipelineOptions
): Promise<RecoveryPipelineResult> {
  const warnings: string[] = [];
  const inputLabel = input.type === "cid" ? input.cid : path.basename(input.filePath);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Recovering batch: ${inputLabel}`);
  console.log("=".repeat(60));

  try {
    // Step 1: Retrieve CAR data
    console.log("\n[stage] 1/3: Retrieving data...");

    let carBytes: Uint8Array;

    if (input.type === "cid") {
      const retrievalResult = await retrieveFromGateway(input.cid, {
        gatewayUrl: options.ipfsGateway,
      });
      carBytes = retrievalResult.carBytes;
      console.log(`[stage] Retrieved ${carBytes.length} bytes from IPFS`);
    } else {
      const retrievalResult = await loadLocalCarFile(input.filePath);
      carBytes = retrievalResult.carBytes;
      console.log(`[stage] Loaded ${carBytes.length} bytes from local file`);
    }

    // Save raw CAR if requested
    if (options.saveCarFiles) {
      const carPath = path.join(options.outputDir, `${inputLabel}.car`);
      fs.mkdirSync(options.outputDir, { recursive: true });
      fs.writeFileSync(carPath, carBytes);
      console.log(`[stage] Saved CAR file to: ${carPath}`);
    }

    // Step 2: Parse CAR and extract v2 batch
    console.log("\n[stage] 2/3: Extracting v2 batch...");
    const carData = await parseCarFile(carBytes);
    const batch = await extractBatch(carData);

    console.log(`[stage] Batch v${batch.batchRoot.version}`);
    console.log(`[stage] ${batch.conversations.size} conversations`);
    console.log(`[stage] Models: ${batch.batchRoot.metadata.models.join(", ")}`);
    console.log(`[stage] Total tokens: ${batch.batchRoot.metadata.totalTokens}`);

    if (batch.batchRoot.previousBatch) {
      console.log(`[stage] Previous batch: ${batch.batchRoot.previousBatch.toString()}`);
    }

    // Step 3: Check encryption on conversations
    console.log("\n[stage] 3/3: Checking encryption...");
    let encryptedCount = 0;
    for (const [, conv] of batch.conversations) {
      if (conv.encrypted) {
        encryptedCount++;
      }
    }

    if (encryptedCount > 0) {
      console.log(`[stage] ${encryptedCount} encrypted conversations found`);
      if (options.skipDecryption) {
        warnings.push(`${encryptedCount} encrypted conversations skipped (--skip-decryption)`);
      } else if (!options.tacoOptions) {
        warnings.push(`${encryptedCount} encrypted conversations found but no TACo options provided`);
      } else {
        console.log(`[stage] Decryption would be attempted with TACo options`);
        // Note: actual decryption of encryptedPayload would happen here
        warnings.push(`TACo decryption of ${encryptedCount} conversations not yet implemented in recovery tool`);
      }
    } else {
      console.log("[stage] No encrypted conversations");
    }

    // Save output
    console.log("\n[stage] Saving recovered data...");
    fs.mkdirSync(options.outputDir, { recursive: true });

    const batchFilename = `batch-${batch.batchRoot.batchId}.json`;
    const outputPath = path.join(options.outputDir, batchFilename);
    await saveBatchToFile(batch, outputPath, { format: options.format });

    let conversationPaths: string[] | undefined;
    if (options.splitConversations) {
      const convDir = path.join(options.outputDir, `batch-${batch.batchRoot.batchId}-conversations`);
      conversationPaths = await saveConversationsToDir(batch, convDir, { format: options.format });
    }

    return {
      source: inputLabel,
      success: true,
      batch,
      outputPath,
      conversationPaths,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[recovery] Failed to recover ${inputLabel}:`, errorMessage);

    return {
      source: inputLabel,
      success: false,
      error: errorMessage,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

/**
 * Recover multiple batches
 */
export async function recoverBatches(
  inputs: Array<{ type: "cid"; cid: string } | { type: "local"; filePath: string }>,
  options: RecoveryPipelineOptions
): Promise<RecoveryPipelineResult[]> {
  console.log(`\nStarting recovery of ${inputs.length} batches...\n`);

  const results: RecoveryPipelineResult[] = [];

  for (const input of inputs) {
    const result = await recoverBatch(input, options);
    results.push(result);
  }

  // Summary
  const successCount = results.filter(r => r.success).length;
  const totalConversations = results.reduce(
    (sum, r) => sum + (r.batch?.conversations.size ?? 0), 0
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Recovery Summary`);
  console.log("=".repeat(60));
  console.log(`  Batches: ${successCount}/${results.length} recovered`);
  console.log(`  Conversations: ${totalConversations} total`);
  console.log(`${"=".repeat(60)}\n`);

  return results;
}

// ── Registry-Based Recovery ─────────────────────────────────────────────────

/**
 * List batches from a v2 registry file
 */
export async function listBatchesFromRegistry(registryPath: string): Promise<Array<{
  batchId: number;
  rootCid: string;
  filecoinCid: string;
  conversationCount: number;
  carSize: number;
  createdAt: number;
  previousBatchCid: string | null;
}>> {
  if (!fs.existsSync(registryPath)) {
    return [];
  }

  const content = fs.readFileSync(registryPath, "utf-8");
  const registry = JSON.parse(content);

  if (registry.version !== "2.0.0") {
    throw new Error(`Unsupported registry version: ${registry.version}. Only v2.0.0 is supported.`);
  }

  return registry.batches ?? [];
}
