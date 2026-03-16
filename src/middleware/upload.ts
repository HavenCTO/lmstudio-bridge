/**
 * Synapse (Filecoin) upload middleware with IPLD-native CID caching.
 *
 * This is a CLEAN BREAK refactor - no backwards compatibility with the old
 * monolithic JSON format. All data uses IPLD structures.
 *
 * Flow:
 * 1. Build IPLD DAG from request/response using IPLDBuilder
 * 2. Check CID cache for deduplication
 * 3. Create CAR file from IPLD blocks
 * 4. Upload CAR to Filecoin via Synapse SDK
 * 5. Cache root CID and component CIDs
 *
 * Required configuration:
 *   --upload                         Enable Synapse upload
 *   --synapse-private-key <hex>      Wallet private key
 *   --synapse-rpc-url <url>          Filecoin RPC URL
 *
 * After this middleware runs the following metadata keys are set:
 *   - `uploadCid`        – the root conversation CID
 *   - `uploadSize`       – bytes uploaded
 *   - `uploadTimestamp`  – ISO-8601 upload time
 *   - `uploadDealId`     – Filecoin deal ID (when available)
 *   - `deduplicated`     – true if content was found in cache
 *   - `rootCid`          – IPLD root CID
 *   - `requestCid`       – Request node CID
 *   - `responseCid`      – Response node CID
 *   - `messageCids`      – Array of message CIDs
 *   - `systemPromptCids` – Array of deduplicated system prompt CIDs
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
  OpenAIChatCompletionRequest,
} from "../types/index.js";
import { CIDCache } from "../lib/cid-cache.js";
import { generateRawCID } from "../lib/cid-utils.js";
import { CID } from "multiformats/cid";
import { createIPLDBuilder, createCAR, IPLDBuilder } from "../lib/ipld-builder.js";
import { createPromptCache } from "../lib/prompt-cache.js";
import {
  createBatchProcessor,
  BatchProcessor,
} from "../lib/registry.js";

// ── Synapse upload function type ────────────────────────────────────────────

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
}

export interface UploadResult {
  cid: string;
  size: number;
  uploadedAt: string;
  dealId?: string;
}

export type SynapseUploadFn = (
  filePath: string,
  onProgress?: (progress: UploadProgress) => void
) => Promise<UploadResult>;

// ── Default Synapse SDK upload implementation ───────────────────────────────

export interface SynapseUploaderOptions {
  privateKey: string;
  rpcUrl?: string;
}

export function createSynapseUploader(opts: SynapseUploaderOptions): {
  upload: SynapseUploadFn;
  cleanup: () => Promise<void>;
} {
  const privateKey = opts.privateKey.startsWith("0x")
    ? opts.privateKey
    : `0x${opts.privateKey}`;
  const rpcUrl =
    opts.rpcUrl ?? "https://api.calibration.node.glif.io/rpc/v1";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let synapseInstance: any = null;

  const upload: SynapseUploadFn = async (filePath, onProgress) => {
    const {
      createUnixfsCarBuilder,
    // @ts-ignore – optional dependency
    } = await import("filecoin-pin/core/unixfs");
    const {
      initializeSynapse,
      createStorageContext,
      cleanupSynapseService,
    // @ts-ignore – optional dependency
    } = await import("filecoin-pin/core/synapse");
    // @ts-ignore – optional dependency
    const { executeUpload, checkUploadReadiness } = await import("filecoin-pin/core/upload");

    const fileData = fsSync.readFileSync(filePath);
    const fileSize = fileData.length;

    onProgress?.({ bytesUploaded: 0, totalBytes: fileSize, percentage: 0 });

    const logger = {
      info: (obj: Record<string, unknown>, msg: string) => console.log(`[synapse] ${msg}`, obj),
      error: (obj: Record<string, unknown>, msg: string) => console.error(`[synapse] ${msg}`, obj),
      warn: (obj: Record<string, unknown>, msg: string) => console.warn(`[synapse] ${msg}`, obj),
      debug: (obj: Record<string, unknown>, msg: string) => console.debug(`[synapse] ${msg}`, obj),
      trace: (obj: Record<string, unknown>, msg: string) => console.debug(`[synapse] ${msg}`, obj),
      fatal: (obj: Record<string, unknown>, msg: string) => console.error(`[synapse] FATAL: ${msg}`, obj),
    };

    const synapse = await initializeSynapse(
      { privateKey, rpcUrl, telemetry: { sentryInitOptions: { enabled: false } } },
      logger as any
    );
    synapseInstance = synapse;

    onProgress?.({ bytesUploaded: 0, totalBytes: fileSize, percentage: 10 });

    const carBuilder = createUnixfsCarBuilder();
    const carResult = await carBuilder.buildCar(filePath, { bare: true });
    const carBytes = fsSync.readFileSync(carResult.carPath);

    onProgress?.({ bytesUploaded: 0, totalBytes: carBytes.length, percentage: 20 });

    await checkUploadReadiness({
      synapse,
      fileSize: carBytes.length,
      autoConfigureAllowances: true,
    });

    onProgress?.({ bytesUploaded: 0, totalBytes: carBytes.length, percentage: 30 });

    const { storage, providerInfo } = await (createStorageContext as any)(synapse);

    onProgress?.({ bytesUploaded: 0, totalBytes: carBytes.length, percentage: 40 });

    const rootCid = carResult.rootCid.toString();
    const uploadResult = await executeUpload(
      { synapse, storage, providerInfo },
      carBytes,
      rootCid as any,
      {
        logger: logger as any,
        contextId: path.basename(filePath),
        ipniValidation: { enabled: false },
        onProgress: (event: { type: string }) => {
          if (event.type === "onUploadComplete") {
            onProgress?.({ bytesUploaded: carBytes.length, totalBytes: carBytes.length, percentage: 80 });
          } else if (event.type === "onPieceAdded") {
            onProgress?.({ bytesUploaded: carBytes.length, totalBytes: carBytes.length, percentage: 90 });
          }
        },
      }
    );

    try { carBuilder.cleanup(carResult.carPath); } catch { /* ignore */ }

    onProgress?.({ bytesUploaded: carBytes.length, totalBytes: carBytes.length, percentage: 100 });

    return {
      cid: rootCid,
      size: carBytes.length,
      uploadedAt: new Date().toISOString(),
      dealId: uploadResult?.pieceId?.toString(),
    };
  };

  const cleanup = async () => {
    if (synapseInstance) {
      try {
        // @ts-ignore – optional dependency
        const { cleanupSynapseService } = await import("filecoin-pin/core/synapse");
        await cleanupSynapseService();
      } catch { /* ignore */ }
      synapseInstance = null;
    }
  };

  return { upload, cleanup };
}

// ── Upload Options ──────────────────────────────────────────────────────────

export interface UploadMiddlewareOptions {
  synapseUpload: SynapseUploadFn;
  cidCache?: CIDCache;
  promptCache?: ReturnType<typeof createPromptCache>;
  /** Enable batch processing for LLaVA export */
  batchProcessor?: BatchProcessor;
  /** Path to registry file (used if batchProcessor not provided) */
  registryPath?: string;
  /** Batch size for automatic batching (default: 100) */
  batchSize?: number;
  /** 
   * When true, accumulate CAR files locally and upload as single batch
   * When false, upload each conversation individually (default: false for backwards compat)
   */
  batchBeforeUpload?: boolean;
  /** Directory for storing pending CAR files (default: ./data) */
  carDir?: string;
}

// ── Batch-before-upload state ──────────────────────────────────────────────

interface PendingConversation {
  requestId: string;
  rootCid: CID;
  blocks: Map<string, Uint8Array>;
  carBytes: Uint8Array;
  request: OpenAIChatCompletionRequest;
  response: any;
}

interface BatchState {
  conversations: PendingConversation[];
  targetSize: number;
}

// ── IPLD Native Upload Middleware ───────────────────────────────────────────

export function createUploadMiddleware(
  options: UploadMiddlewareOptions
): Middleware {
  const { 
    synapseUpload, 
    cidCache, 
    promptCache, 
    batchProcessor, 
    registryPath, 
    batchSize,
    batchBeforeUpload = false,
    carDir = "./data"
  } = options;

  // Initialize batch processor if enabled
  let processor: BatchProcessor | undefined = batchProcessor;
  if (!processor && registryPath && !batchBeforeUpload) {
    processor = createBatchProcessor({
      batchSize: batchSize ?? 100,
      registryPath,
    });
  }

  // Batch-before-upload state
  let batchState: BatchState | null = batchBeforeUpload ? {
    conversations: [],
    targetSize: batchSize ?? 10,
  } : null;

  // Ensure car directory exists
  const ensureCarDir = async () => {
    try {
      await fs.mkdir(carDir, { recursive: true });
    } catch {
      // Ignore errors - directory may already exist
    }
  };

  return {
    name: "upload",

    async onRequest(
      payload: RequestPayload,
      next: NextFunction
    ): Promise<void> {
      // Capture the request for IPLD building
      if (!payload.context.metadata.capturedRequest) {
        payload.context.metadata.capturedRequest = payload.openaiRequest;
      }
      await next();
    },

    async onResponse(
      payload: ResponsePayload,
      next: NextFunction
    ): Promise<void> {
      const request = payload.context.metadata.capturedRequest as OpenAIChatCompletionRequest;
      const response = payload.openaiResponse;

      // Create IPLD builder
      const builder = createIPLDBuilder();

      // Build IPLD DAG
      const conversationRoot = await builder.buildConversation(request, response);

      const rootCidString = conversationRoot.rootCid.toString();

      // Check CID cache for deduplication
      if (cidCache) {
        const exists = await cidCache.has(rootCidString);
        if (exists) {
          const cachedEntry = await cidCache.get(rootCidString);
          
          payload.context.metadata.uploadCid = rootCidString;
          payload.context.metadata.rootCid = rootCidString;
          payload.context.metadata.requestCid = conversationRoot.requestCid.toString();
          payload.context.metadata.responseCid = conversationRoot.responseCid.toString();
          payload.context.metadata.messageCids = conversationRoot.messageCids.map(c => c.toString());
          payload.context.metadata.uploadSize = cachedEntry?.size ?? conversationRoot.totalSize;
          payload.context.metadata.uploadTimestamp = new Date(cachedEntry?.uploadedAt ?? Date.now()).toISOString();
          payload.context.metadata.deduplicated = true;
          
          if (promptCache && request.messages.length > 0 && request.messages[0].role === "system") {
            const systemContent = typeof request.messages[0].content === "string"
              ? request.messages[0].content
              : JSON.stringify(request.messages[0].content);
            const systemCid = await promptCache.get(systemContent);
            if (systemCid) {
              payload.context.metadata.systemPromptCids = [systemCid.toString()];
            }
          }

          console.log(
            `[upload] ${payload.context.requestId} | ⟲ DEDUPLICATED root=${rootCidString} (${conversationRoot.blockCount} blocks) - skipping upload`
          );

          await next();
          return;
        }
      }

      // Create CAR file
      const blocks = builder.getBlocks();
      const car = await createCAR(conversationRoot.rootCid, blocks);

      if (batchBeforeUpload && batchState) {
        // ============ BATCH-BEFORE-UPLOAD MODE ============
        // Store CAR file locally, upload when batch is full
        
        const pending: PendingConversation = {
          requestId: payload.context.requestId,
          rootCid: conversationRoot.rootCid,
          blocks,
          carBytes: car.bytes,
          request,
          response,
        };
        
        batchState.conversations.push(pending);
        
        console.log(
          `[upload] ${payload.context.requestId} | Added to batch (size: ${batchState.conversations.length}/${batchState.targetSize})`
        );
        
        // Check if batch is full
        if (batchState.conversations.length >= batchState.targetSize) {
          await flushBatch();
        }
        
        // Set pending metadata
        payload.context.metadata.uploadCid = rootCidString;
        payload.context.metadata.rootCid = rootCidString;
        payload.context.metadata.requestCid = conversationRoot.requestCid.toString();
        payload.context.metadata.responseCid = conversationRoot.responseCid.toString();
        payload.context.metadata.messageCids = conversationRoot.messageCids.map(c => c.toString());
        payload.context.metadata.deduplicated = false;
        payload.context.metadata.batchPending = true;
        
      } else {
        // ============ INDIVIDUAL UPLOAD MODE (original behavior) ============
        
        // Write CAR to temp file
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(
          tmpDir,
          `llm-shim-${payload.context.requestId}.car`
        );
        fsSync.writeFileSync(tmpFile, car.bytes);

        try {
          console.log(
            `[upload] ${payload.context.requestId} | IPLD DAG with ${conversationRoot.blockCount} blocks, ${car.bytes.length} bytes`
          );
          console.log(
            `[upload] ${payload.context.requestId} | root=${rootCidString}`
          );

          const result = await synapseUpload(tmpFile, (p) => {
            if (p.percentage % 20 === 0) {
              console.log(
                `[upload] ${payload.context.requestId} | ${p.percentage}%`
              );
            }
          });

          // Set metadata
          payload.context.metadata.uploadCid = result.cid;
          payload.context.metadata.rootCid = rootCidString;
          payload.context.metadata.requestCid = conversationRoot.requestCid.toString();
          payload.context.metadata.responseCid = conversationRoot.responseCid.toString();
          payload.context.metadata.messageCids = conversationRoot.messageCids.map(c => c.toString());
          payload.context.metadata.uploadSize = result.size;
          payload.context.metadata.uploadTimestamp = result.uploadedAt;
          payload.context.metadata.deduplicated = false;

          if (result.dealId) {
            payload.context.metadata.uploadDealId = result.dealId;
          }

          if (result.cid !== rootCidString) {
            console.warn(
              `[upload] ${payload.context.requestId} | ⚠️ CID mismatch! local=${rootCidString}, server=${result.cid}`
            );
          }

          console.log(
            `[upload] ${payload.context.requestId} | ✓ root=${result.cid} (${result.size} bytes)`
          );

          // Add to CID cache
          if (cidCache) {
            await cidCache.add(rootCidString, {
              size: result.size,
              uploadedAt: Date.now(),
              dealStatus: "pending",
              mimeType: "application/vnd.ipld.car",
            });

            const componentEntries = [
              { cid: conversationRoot.requestCid.toString(), size: 0 },
              { cid: conversationRoot.responseCid.toString(), size: 0 },
              { cid: conversationRoot.metadataCid.toString(), size: 0 },
              ...conversationRoot.messageCids.map(c => ({ cid: c.toString(), size: 0 })),
            ];

            await cidCache.addBatch(componentEntries.map(e => ({
              cid: e.cid,
              size: e.size,
              uploadedAt: Date.now(),
              dealStatus: "pending",
              mimeType: "application/vnd.ipld.dag-json",
            })));
          }

          // Track system prompt deduplication
          if (promptCache && request.messages.length > 0 && request.messages[0].role === "system") {
            const systemContent = typeof request.messages[0].content === "string"
              ? request.messages[0].content
              : JSON.stringify(request.messages[0].content);
            const existingCid = await promptCache.get(systemContent);
            if (existingCid) {
              payload.context.metadata.systemPromptCids = [existingCid.toString()];
            } else {
              const systemMessageCid = conversationRoot.messageCids[0];
              if (systemMessageCid) {
                await promptCache.set(systemContent, systemMessageCid);
                payload.context.metadata.systemPromptCids = [systemMessageCid.toString()];
              }
            }
          }

          // Add to batch processor if enabled
          if (processor) {
            const rootCidObj = CID.parse(rootCidString);
            const batchMetadata = await processor.addConversation(rootCidObj);
            
            if (batchMetadata) {
              payload.context.metadata.batchId = batchMetadata.batchId;
              payload.context.metadata.batchRootCid = batchMetadata.rootCid;
              payload.context.metadata.batchSize = batchMetadata.conversationCount;
              
              console.log(
                `[upload] ${payload.context.requestId} | ✓ Batch ${batchMetadata.batchId} created with ${batchMetadata.conversationCount} conversations`
              );
            }
          }

        } finally {
          try { fsSync.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      }

      await next();
    },
  };

  // Flush batch - merge CARs and upload as single file
  async function flushBatch(): Promise<void> {
    if (!batchState || batchState.conversations.length === 0) return;
    
    const batchId = Date.now();
    const batchCarDir = path.join(carDir, `batch-${batchId}`);
    try {
      await fs.mkdir(batchCarDir, { recursive: true });
    } catch {
      // Ignore errors - directory may already exist
    }
    
    console.log(
      `[upload] batch | Merging ${batchState.conversations.length} conversations...`
    );
    
    // Write individual CAR files to batch directory
    const carFiles: string[] = [];
    const allBlocks = new Map<string, Uint8Array>();
    const rootCids: CID[] = [];
    
    for (const conv of batchState.conversations) {
      const carPath = path.join(batchCarDir, `${conv.requestId}.car`);
      fsSync.writeFileSync(carPath, conv.carBytes);
      carFiles.push(carPath);
      
      // Collect all blocks for merged CAR
      for (const [cid, block] of conv.blocks) {
        allBlocks.set(cid, block);
      }
      rootCids.push(conv.rootCid);
    }
    
    // Create merged CAR with all blocks
    const mergedCar = await createCAR(rootCids[0], allBlocks);
    const mergedCarPath = path.join(batchCarDir, "merged.car");
    fsSync.writeFileSync(mergedCarPath, mergedCar.bytes);
    
    console.log(
      `[upload] batch | Merged CAR: ${mergedCar.bytes.length} bytes, ${allBlocks.size} blocks`
    );
    
    // Upload merged CAR
    console.log(`[upload] batch | Uploading to Filecoin...`);
    
    const result = await synapseUpload(mergedCarPath, (p) => {
      if (p.percentage % 20 === 0) {
        console.log(`[upload] batch | ${p.percentage}%`);
      }
    });
    
    console.log(
      `[upload] batch | ✓ Uploaded ${result.cid} (${result.size} bytes)`
    );
    
    // Update metadata for all conversations in batch
    for (const conv of batchState.conversations) {
      // Note: We can't retroactively update payload.context.metadata
      // but we can log and update registry
    }
    
    // Add to batch processor / registry
    if (processor) {
      const batchMetadata = await processor.flush();
      if (batchMetadata) {
        batchMetadata.rootCid = result.cid;
        batchMetadata.carSize = result.size;
        batchMetadata.filecoinCid = result.cid;
        console.log(
          `[upload] batch | ✓ Registry updated with batch ${batchMetadata.batchId}`
        );
      }
    }
    
    // Clear batch state
    batchState.conversations = [];
  }
}
