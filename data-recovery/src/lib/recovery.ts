/**
 * Recovery Orchestrator Module
 *
 * Coordinates the complete data recovery workflow:
 * 1. Retrieve CAR files from IPFS/Synapse
 * 2. Extract IPLD conversation data
 * 3. Decrypt TACo-encrypted payloads
 * 4. Save recovered data to output directory
 */

import * as fs from "fs";
import * as path from "path";
import { CID } from "multiformats/cid";
import {
  batchRetrieve,
  retrieveFromGateway,
  loadLocalCarFile,
} from "./lib/retriever";
import {
  parseCarFile,
  extractConversation,
  saveConversationToFile,
  CarFileData,
  RecoveredConversation,
} from "./lib/car-extractor";
import {
  decryptHybridData,
  isDataEncrypted,
  parseEncryptionMetadata,
  TacoDecryptionOptions,
  EncryptionMetadata,
} from "./lib/decryptor";
import {
  RecoveryOptions,
  DecryptionResult,
  RecoveredMetadata,
} from "../types";

// ── Recovery Pipeline ───────────────────────────────────────────────────────

export interface RecoveryPipelineResult {
  /** The original CID */
  cid: string;
  /** Whether recovery was successful */
  success: boolean;
  /** Retrieved CAR file data */
  carData?: CarFileData;
  /** Extracted conversation */
  conversation?: RecoveredConversation;
  /** Decryption result */
  decryption?: DecryptionResult;
  /** Path to saved output file */
  outputPath?: string;
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
  /** File naming pattern (default: {cid}.json) */
  filenamePattern?: string;
}

/**
 * Recover a single conversation from CID or local file
 */
export async function recoverConversation(
  input: { type: "cid"; cid: string } | { type: "local"; filePath: string },
  options: RecoveryPipelineOptions
): Promise<RecoveryPipelineResult> {
  const warnings: string[] = [];
  const inputLabel = input.type === "cid" ? input.cid : path.basename(input.filePath);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Recovering: ${inputLabel}`);
  console.log("=".repeat(60));

  try {
    // Step 1: Retrieve CAR data
    console.log("\n[stage] 1/4: Retrieving data...");
    
    let carBytes: Uint8Array;
    let rootCid: CID;

    if (input.type === "cid") {
      const retrievalResult = await retrieveFromGateway(input.cid, {
        gatewayUrl: options.ipfsGateway,
      });
      carBytes = retrievalResult.carBytes;
      rootCid = retrievalResult.cid;
      console.log(`[stage] Retrieved ${carBytes.length} bytes from IPFS`);
    } else {
      const retrievalResult = await loadLocalCarFile(input.filePath);
      carBytes = retrievalResult.carBytes;
      rootCid = retrievalResult.cid;
      console.log(`[stage] Loaded ${carBytes.length} bytes from local file`);
    }

    // Save raw CAR if requested
    if (options.saveCarFiles) {
      const carPath = path.join(options.outputDir, `${rootCid.toString()}.car`);
      fs.mkdirSync(options.outputDir, { recursive: true });
      fs.writeFileSync(carPath, carBytes);
      console.log(`[stage] Saved CAR file to: ${carPath}`);
    }

    // Step 2: Parse CAR and extract conversation
    console.log("\n[stage] 2/4: Parsing CAR file...");
    const carData = await parseCarFile(carBytes);
    console.log(`[stage] Extracted ${carData.blocks.size} blocks`);

    console.log("\n[stage] 3/4: Reconstructing conversation...");
    const conversation = await extractConversation(carData);
    console.log(`[stage] Conversation model: ${conversation.request.model}`);
    console.log(`[stage] Messages: ${conversation.request.messages.length}`);

    // Step 3: Check and handle encryption
    let decryptionResult: DecryptionResult | undefined;
    
    if (isDataEncrypted(conversation.metadata)) {
      console.log("\n[stage] 4/4: Data is encrypted, decrypting...");
      
      if (options.skipDecryption) {
        warnings.push("Encryption detected but decryption skipped per options");
        decryptionResult = {
          success: false,
          error: "Decryption skipped",
        };
      } else if (!options.tacoOptions) {
        warnings.push("Encryption detected but no TACo options provided");
        decryptionResult = {
          success: false,
          error: "TACo options required for decryption",
        };
      } else {
        // Try to extract encrypted buffer from conversation
        // Note: In the hybrid encryption flow, the encrypted buffer is separate
        // from the IPLD conversation structure
        
        // For now, we'll note that decryption would be needed
        // The actual encrypted payload would need to be retrieved separately
        // or passed in through metadata
        console.log("[stage] Note: Encrypted payload retrieval requires additional metadata");
        console.log("[stage] To decrypt, you need the encrypted buffer from the upload process");
        
        decryptionResult = {
          success: false,
          error: "Encrypted payload not available - requires separate retrieval of encrypted buffer",
        };
      }
    } else {
      console.log("\n[stage] 4/4: Data is not encrypted");
      decryptionResult = {
        success: true,
        decryptedBuffer: Buffer.from(JSON.stringify(conversation)),
      };
    }

    // Step 5: Save recovered conversation
    console.log("\n[stage] Saving recovered data...");
    
    const filename = options.filenamePattern
      ? options.filenamePattern.replace("{cid}", rootCid.toString())
      : `${rootCid.toString()}.json`;
    
    const outputPath = path.join(options.outputDir, filename);
    fs.mkdirSync(options.outputDir, { recursive: true });
    
    await saveConversationToFile(carData, outputPath, { format: "pretty-json" });
    console.log(`[stage] Saved to: ${outputPath}`);

    return {
      cid: rootCid.toString(),
      success: true,
      carData,
      conversation,
      decryption: decryptionResult,
      outputPath,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[recovery] Failed to recover ${inputLabel}:`, errorMessage);
    
    return {
      cid: input.type === "cid" ? input.cid : "unknown",
      success: false,
      error: errorMessage,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

/**
 * Recover multiple conversations
 */
export async function recoverConversations(
  inputs: Array<{ type: "cid"; cid: string } | { type: "local"; filePath: string }>,
  options: RecoveryPipelineOptions
): Promise<RecoveryPipelineResult[]> {
  console.log(`\nStarting recovery of ${inputs.length} conversations...\n`);

  const results: RecoveryPipelineResult[] = [];

  for (const input of inputs) {
    const result = await recoverConversation(input, options);
    results.push(result);
  }

  // Summary
  const successCount = results.filter(r => r.success).length;
  const warningCount = results.filter(r => r.warnings?.length ?? 0 > 0).length;
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Recovery Summary`);
  console.log("=".repeat(60));
  console.log(`  Total: ${results.length}`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Failed: ${results.length - successCount}`);
  console.log(`  With warnings: ${warningCount}`);
  console.log(`${"=".repeat(60)}\n`);

  return results;
}

// ── Encrypted Payload Recovery ──────────────────────────────────────────────

/**
 * Options for recovering encrypted payloads
 */
export interface EncryptedPayloadRecoveryOptions {
  /** Directory containing metadata files from upload process */
  metadataDir: string;
  /** Output directory for decrypted data */
  outputDir: string;
  /** IPFS gateway URL */
  ipfsGateway?: string;
  /** TACo decryption options */
  tacoOptions: TacoDecryptionOptions;
  /** Verbose logging */
  verbose?: boolean;
}

export interface EncryptedPayloadResult {
  cid: string;
  success: boolean;
  decryptedData?: unknown;
  metadata?: RecoveredMetadata;
  error?: string;
}

/**
 * Recover and decrypt encrypted payloads using metadata files
 * 
 * This function looks for metadata files created during the upload process
 * that contain references to both the IPLD conversation and the encrypted payload.
 */
export async function recoverEncryptedPayloads(
  options: EncryptedPayloadRecoveryOptions
): Promise<EncryptedPayloadResult[]> {
  console.log("\n🔐 Recovering encrypted payloads...\n");

  const results: EncryptedPayloadResult[] = [];
  const metadataDir = options.metadataDir;

  if (!fs.existsSync(metadataDir)) {
    throw new Error(`Metadata directory not found: ${metadataDir}`);
  }

  // Find all metadata JSON files
  const files = fs.readdirSync(metadataDir);
  const metadataFiles = files.filter(f => f.endsWith(".json"));

  console.log(`Found ${metadataFiles.length} metadata files\n`);

  for (const filename of metadataFiles) {
    const filepath = path.join(metadataDir, filename);
    console.log(`Processing: ${filename}`);

    try {
      const metadataContent = fs.readFileSync(filepath, "utf-8");
      const metadata = JSON.parse(metadataContent);

      const cid = metadata.uploadCid || metadata.rootCid;
      if (!cid) {
        throw new Error("No CID found in metadata file");
      }

      // Check if this conversation is encrypted
      const isEncrypted = metadata.encryptedKey !== undefined || 
                         metadata.encryption?.encrypted === true;

      if (!isEncrypted) {
        console.log(`  CID ${cid} is not encrypted, skipping decryption`);
        continue;
      }

      console.log(`  CID ${cid} is encrypted, attempting decryption...`);

      // Prepare encryption metadata
      const encryptionMetadata: EncryptionMetadata = {
        version: "hybrid-v1",
        encryptedKey: metadata.encryptedKey,
        dataToEncryptHash: metadata.keyHash || metadata.dataToEncryptHash,
        algorithm: "AES-GCM",
        keyLength: 256,
        ivLengthBytes: 12,
        accessControlConditions: metadata.accessControlConditions || [],
        chain: metadata.chain || "ethereum",
      };

      // Note: The encrypted buffer needs to be retrieved separately
      // This would typically be stored alongside the metadata or
      // retrieved from a separate location during the upload process
      
      console.log(`  Note: Encrypted buffer must be provided separately`);
      console.log(`  To fully decrypt, you need the encrypted payload from the upload session`);

      results.push({
        cid,
        success: false,
        error: "Encrypted buffer not available - check upload logs for payload location",
        metadata: metadata as RecoveredMetadata,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to process ${filename}:`, errorMessage);
      
      results.push({
        cid: "unknown",
        success: false,
        error: errorMessage,
      });
    }
  }

  return results;
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * List available CIDs from a cache or metadata directory
 */
export async function listAvailableCids(metadataDir: string): Promise<Array<{
  cid: string;
  timestamp?: string;
  size?: number;
  encrypted: boolean;
}> > {
  if (!fs.existsSync(metadataDir)) {
    return [];
  }

  const files = fs.readdirSync(metadataDir);
  const results: Array<{
    cid: string;
    timestamp?: string;
    size?: number;
    encrypted: boolean;
  }> = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const filepath = path.join(metadataDir, file);
      const content = fs.readFileSync(filepath, "utf-8");
      const metadata = JSON.parse(content);

      const cid = metadata.uploadCid || metadata.rootCid;
      if (cid) {
        results.push({
          cid,
          timestamp: metadata.uploadTimestamp,
          size: metadata.uploadSize,
          encrypted: !!metadata.encryptedKey || metadata.version === "hybrid-v1",
        });
      }
    } catch {
      // Skip invalid files
    }
  }

  return results;
}
