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

import * as fs from "fs";
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
import { createIPLDBuilder, createCAR, IPLDBuilder } from "../lib/ipld-builder.js";
import { createPromptCache } from "../lib/prompt-cache.js";

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

    const fileData = fs.readFileSync(filePath);
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
    const carBytes = fs.readFileSync(carResult.carPath);

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
}

// ── IPLD Native Upload Middleware ───────────────────────────────────────────

export function createUploadMiddleware(
  options: UploadMiddlewareOptions
): Middleware {
  const { synapseUpload, cidCache, promptCache } = options;

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
          
          // Check for system prompt deduplication
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

      // Write CAR to temp file
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(
        tmpDir,
        `llm-shim-${payload.context.requestId}.car`
      );
      fs.writeFileSync(tmpFile, car.bytes);

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

        // Set metadata for downstream middleware
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

        // Verify CID matches
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

          // Also cache individual component CIDs for granular deduplication
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
            // Get the CID of the first message (system prompt)
            const systemMessageCid = conversationRoot.messageCids[0];
            if (systemMessageCid) {
              await promptCache.set(systemContent, systemMessageCid);
              payload.context.metadata.systemPromptCids = [systemMessageCid.toString()];
            }
          }
        }

      } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }

      await next();
    },
  };
}
