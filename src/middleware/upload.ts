/**
 * Synapse (Filecoin) upload middleware — V2 Architecture
 *
 * Hot path stores raw JSON with zero IPLD overhead.
 * Background flush builds batch archives via archive-builder.ts.
 *
 * Flow:
 * 1. onResponse: Store raw conversation JSON in batch buffer (zero crypto)
 * 2. When batch is full: snapshot buffer, enqueue for background flush
 * 3. Background: Build IPLD archive → write CAR → upload to Filecoin → update registry
 *
 * Required configuration:
 *   --upload                         Enable Synapse upload
 *   --synapse-private-key <hex>      Wallet private key
 *   --synapse-rpc-url <url>          Filecoin RPC URL
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
} from "../types/index.js";
import { buildBatchArchive, ArchiveConversation } from "../lib/archive-builder.js";
import { createDedupCache, computeContentHash, DedupCache } from "../lib/dedup-cache.js";
import { createRegistry, Registry } from "../lib/registry.js";
import { FlushQueue, FlushJob } from "../lib/flush-queue.js";
import { CID } from "multiformats/cid";

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

    const fileData = await fs.readFile(filePath);
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
    const carBytes = await fs.readFile(carResult.carPath);

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
  /** Path to registry file */
  registryPath?: string;
  /** Batch size for automatic batching (default: 10) */
  batchSize?: number;
  /** Directory for storing pending CAR files (default: ./data) */
  carDir?: string;
  /** Delete CAR files from disk after successful Filecoin upload (default: true) */
  cleanupAfterUpload?: boolean;
  /** Maximum number of batch records to keep in registry (default: 100, 0 = unlimited) */
  maxRegistryBatches?: number;
}

// ── Pending Conversation (raw JSON, no IPLD) ────────────────────────────────

export interface PendingConversation {
  requestId: string;
  timestamp: number;
  request: OpenAIChatCompletionRequest;
  response: OpenAIChatCompletionResponse;
  encrypted: boolean;
  encryptedBuffer?: Buffer;
}

// ── Upload Middleware Handle ────────────────────────────────────────────────

export interface UploadMiddlewareHandle {
  middleware: Middleware;
  drainFlushes(timeoutMs?: number): Promise<void>;
  getFlushStats(): { pending: number; completed: number; failed: number; deadLettered: number; activeJob: boolean };
}

// ── Helper: extract parameters from request ─────────────────────────────────

function extractParameters(request: OpenAIChatCompletionRequest): Record<string, unknown> | undefined {
  const params: Record<string, unknown> = {};
  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (request.max_tokens !== undefined) params.max_tokens = request.max_tokens;
  if (request.top_p !== undefined) params.top_p = request.top_p;
  if (request.frequency_penalty !== undefined) params.frequency_penalty = request.frequency_penalty;
  if (request.presence_penalty !== undefined) params.presence_penalty = request.presence_penalty;
  if (request.stream !== undefined) params.stream = request.stream;
  return Object.keys(params).length > 0 ? params : undefined;
}

// ── Upload Middleware ───────────────────────────────────────────────────────

export function createUploadMiddleware(
  options: UploadMiddlewareOptions
): UploadMiddlewareHandle {
  const {
    synapseUpload,
    registryPath = "./registry.json",
    batchSize: targetBatchSize = 10,
    carDir = "./data",
    cleanupAfterUpload = true,
    maxRegistryBatches = 100,
  } = options;

  // Create v2 registry
  const registry: Registry = createRegistry();
  const registryLoadPromise = registry.load(registryPath).then(() => {
    console.log(`[upload] Registry loaded from ${registryPath}`);
  }).catch(() => {
    console.log(`[upload] Starting fresh registry (file not found: ${registryPath})`);
  });

  // Dedup cache
  const dedupCache: DedupCache = createDedupCache();

  // Batch buffer (raw conversations, no IPLD)
  const batchBuffer: PendingConversation[] = [];

  // Track last batch CID for provenance chain
  let lastBatchCid: CID | null = null;

  // Ensure car directory exists
  const ensureCarDir = async () => {
    try {
      await fs.mkdir(carDir, { recursive: true });
    } catch {
      // Ignore errors - directory may already exist
    }
  };

  // ── Background flush implementation ─────────────────────────────────────

  async function flushBatch(
    conversations: PendingConversation[],
    batchTimestamp: number
  ): Promise<void> {
    if (conversations.length === 0) return;

    // 1. Convert to ArchiveConversation format
    const archiveConversations: ArchiveConversation[] = conversations.map((conv) => ({
      id: conv.requestId,
      timestamp: conv.timestamp,
      model: conv.request.model,
      request: {
        messages: conv.request.messages.map((m) => ({
          role: m.role,
          content: m.content as string | unknown[],
          name: m.name,
        })),
        parameters: extractParameters(conv.request),
      },
      response: {
        id: (conv.response as any).id ?? "",
        model: (conv.response as any).model ?? conv.request.model,
        created: (conv.response as any).created ?? Math.floor(Date.now() / 1000),
        choices: ((conv.response as any).choices ?? []).map((c: any) => ({
          index: c.index ?? 0,
          message: { role: c.message?.role ?? "assistant", content: c.message?.content ?? "" },
          finish_reason: c.finish_reason ?? "",
        })),
        usage: (conv.response as any).usage,
      },
      encrypted: conv.encrypted,
      encryptedPayload: conv.encryptedBuffer ? new Uint8Array(conv.encryptedBuffer) : undefined,
    }));

    // 2. Build archive (IPLD blocks + CAR)
    const archive = await buildBatchArchive(
      archiveConversations,
      batchTimestamp,
      "2.0.0",
      lastBatchCid
    );

    // 3. Write CAR to disk (crash recovery)
    const batchCarDir = path.join(carDir, `batch-${batchTimestamp}`);
    await fs.mkdir(batchCarDir, { recursive: true });
    const carPath = path.join(batchCarDir, "merged.car");
    await fs.writeFile(carPath, archive.carBytes);

    console.log(
      `[upload] batch | Merged CAR: ${archive.carBytes.length} bytes, ${archive.blockCount} blocks`
    );

    // 4. Upload to Filecoin
    console.log(`[upload] batch | Uploading to Filecoin...`);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Upload timeout after 10 minutes")), 600000);
    });

    const result = await Promise.race([
      synapseUpload(carPath, (p) => {
        if (p.percentage % 20 === 0) {
          console.log(`[upload] batch | ${p.percentage}%`);
        }
      }),
      timeoutPromise,
    ]);

    console.log(`[upload] batch | ✓ Uploaded ${result.cid} (${result.size} bytes)`);

    // 5. Wait for registry to load before updating
    try {
      await registryLoadPromise;
    } catch {
      // Expected if file doesn't exist — fresh registry
    }

    // 6. Update registry
    await registry.addBatch({
      batchId: batchTimestamp,
      rootCid: archive.rootCid.toString(),
      filecoinCid: result.cid,
      conversationCids: [...archive.conversationCids.values()].map((c) => c.toString()),
      carSize: archive.carBytes.length,
      conversationCount: archiveConversations.length,
      createdAt: Date.now(),
      previousBatchCid: lastBatchCid?.toString() ?? null,
    });
    await registry.persist(registryPath);

    const savedState = await registry.getState();
    console.log(
      `[upload] batch | ✓ Registry updated: ${savedState.totalBatches} batches, ${savedState.totalConversations} conversations`
    );

    // 7. Update chain pointer
    lastBatchCid = archive.rootCid;

    // 8. Update dedup cache
    for (const conv of archiveConversations) {
      const hash = await computeContentHash(conv.request, conv.response);
      dedupCache.add(hash);
    }

    // 9. Cleanup: delete CAR files from disk after successful upload
    if (cleanupAfterUpload) {
      try {
        await fs.rm(batchCarDir, { recursive: true, force: true });
        console.log(`[upload] batch | ✓ Cleaned up ${batchCarDir}`);
      } catch {
        console.warn(`[upload] batch | Failed to cleanup ${batchCarDir}`);
      }
    }

    // 10. Prune old registry entries to bound disk usage
    if (maxRegistryBatches > 0) {
      const pruned = await registry.prune(maxRegistryBatches);
      if (pruned.length > 0) {
        await registry.persist(registryPath);
        console.log(
          `[upload] batch | ✓ Pruned ${pruned.length} old batch records from registry`
        );

        // Also clean up CAR directories for pruned batches (if they still exist)
        if (cleanupAfterUpload) {
          for (const record of pruned) {
            const oldBatchDir = path.join(carDir, `batch-${record.batchId}`);
            try {
              await fs.rm(oldBatchDir, { recursive: true, force: true });
            } catch {
              // Already cleaned up or doesn't exist — fine
            }
          }
        }
      }
    }
  }

  // ── Flush queue ─────────────────────────────────────────────────────────

  const flushQueueInstance = new FlushQueue(
    async (job: FlushJob) => {
      await flushBatch(
        job.conversations as unknown as PendingConversation[],
        job.batchTimestamp
      );
    },
    {
      maxRetries: 3,
      retryDelayMs: 5000,
      maxRetryDelayMs: 60000,
      maxQueueDepth: 50,
    }
  );

  flushQueueInstance.onComplete((job, error) => {
    if (error) {
      console.error(
        `[upload] background flush failed permanently: batch ${job.batchTimestamp}, ` +
        `${job.conversations.length} conversations — CAR files preserved on disk for recovery`
      );
    }
  });

  // ── Crash recovery ────────────────────────────────────────────────────

  async function recoverPendingBatches(): Promise<void> {
    try {
      const entries = await fs.readdir(carDir, { withFileTypes: true });
      const registryState = await registry.getState();
      const knownBatchIds = new Set(
        registryState.batches.map((b) => b.batchId)
      );

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("batch-")) continue;
        const timestamp = parseInt(entry.name.replace("batch-", ""), 10);
        if (knownBatchIds.has(timestamp)) continue;

        const mergedCarPath = path.join(carDir, entry.name, "merged.car");
        try {
          await fs.access(mergedCarPath);
          console.log(`[upload] recovering unflushed batch: ${entry.name}`);
          flushQueueInstance.enqueueRecovery(mergedCarPath, timestamp);
        } catch {
          // No merged.car — incomplete batch, skip
        }
      }
    } catch {
      // carDir doesn't exist yet — nothing to recover
    }
  }

  // Kick off recovery after registry loads (non-blocking)
  registryLoadPromise.then(() => recoverPendingBatches()).catch(() => {});

  // ── Middleware handlers ─────────────────────────────────────────────────

  const middleware: Middleware = {
    name: "upload",

    async onRequest(
      payload: RequestPayload,
      next: NextFunction
    ): Promise<void> {
      // Capture the request for later use
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

      // CRITICAL SECURITY CHECK: If encryption is enabled, use encrypted buffer
      const encryptedBuffer = payload.context.metadata.encryptedBuffer as Buffer | undefined;
      const isEncrypted = !!encryptedBuffer;

      // FAIL-CLOSED: Check if taco-encrypt middleware was registered
      const pipeline = (payload.context as any).pipeline;
      const hasTacoEncrypt = pipeline?.middlewares?.some((m: any) => m.name === 'taco-encrypt');

      if (hasTacoEncrypt && !isEncrypted) {
        throw new Error(
          `[upload] SECURITY: taco-encrypt middleware is registered but no encryptedBuffer found. ` +
          `Refusing to upload plaintext data. RequestId: ${payload.context.requestId}`
        );
      }

      if (isEncrypted) {
        console.log(
          `[upload] ${payload.context.requestId} | Using TACo-encrypted buffer (${encryptedBuffer!.length} bytes)`
        );
      }

      // Store raw conversation for background processing — ZERO IPLD work
      const pending: PendingConversation = {
        requestId: payload.context.requestId,
        timestamp: Date.now(),
        request,
        response,
        encrypted: isEncrypted,
        encryptedBuffer,
      };

      batchBuffer.push(pending);

      console.log(
        `[upload] ${payload.context.requestId} | Added to batch (size: ${batchBuffer.length}/${targetBatchSize})`
      );

      // Check batch threshold — snapshot and enqueue (non-blocking)
      if (batchBuffer.length >= targetBatchSize) {
        const snapshot = batchBuffer.splice(0);
        console.log(
          `[upload] ${payload.context.requestId} | Batch full (${snapshot.length}/${targetBatchSize}), queued for background flush`
        );
        flushQueueInstance.enqueue(snapshot as any, Date.now());
      }

      // Set minimal metadata — response returns immediately
      payload.context.metadata.batchPending = true;
      payload.context.metadata.requestId = pending.requestId;

      await next();
      // ← Client gets response immediately. Zero IPLD work on hot path.
    },
  };

  // ── Return handle ───────────────────────────────────────────────────────

  return {
    middleware,
    drainFlushes: (timeoutMs?: number) => flushQueueInstance.drain(timeoutMs),
    getFlushStats: () => flushQueueInstance.getStats(),
  };
}
