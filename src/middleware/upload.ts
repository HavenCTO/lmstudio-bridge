/**
 * Synapse (Filecoin) upload middleware.
 *
 * Writes the combined request + response payload (or its compressed /
 * encrypted form) to a temporary file and uploads it to Filecoin via
 * the Synapse SDK (`filecoin-pin`).
 *
 * Picks the "best" buffer available in `context.metadata`:
 *   1. `encryptedBuffer` – if the encrypt middleware ran
 *   2. `gzipBuffer`      – if only gzip ran
 *   3. Falls back to serialising a combined `{ request, response }` JSON
 *
 * The request is captured during `onRequest` (if not already captured
 * by an earlier middleware) so the uploaded artifact always contains
 * both sides of the conversation.  This works transparently with all
 * OpenAI content formats including multi-part messages with inline
 * base64 images (`image_url` content parts).
 *
 * Required configuration:
 *   --upload                         Enable Synapse upload
 *   --synapse-private-key <hex>      Wallet private key (or HAVEN_PRIVATE_KEY env)
 *   --synapse-rpc-url <url>          Filecoin RPC URL
 *
 * After this middleware runs the following metadata keys are set:
 *   - `capturedRequest`  – the original OpenAI request (if not already set)
 *   - `uploadCid`        – the IPFS/Filecoin CID of the uploaded content
 *   - `uploadSize`       – bytes uploaded
 *   - `uploadTimestamp`  – ISO-8601 upload time
 *   - `uploadDealId`     – Filecoin deal ID (when available)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from "../types";

// ── Synapse upload function type ────────────────────────────────────────────

/**
 * Upload progress event emitted by the upload function.
 */
export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
}

/**
 * Result returned by the upload function.
 */
export interface UploadResult {
  cid: string;
  size: number;
  uploadedAt: string;
  dealId?: string;
}

/**
 * Callback that performs the actual Synapse upload.
 *
 * This indirection keeps the middleware unit-testable and avoids
 * hard-coupling to the Synapse SDK (which uses Deno-specific APIs
 * in js-services).
 *
 * The function receives:
 *   - filePath: absolute path to a temporary file to upload
 *   - onProgress: optional progress callback
 * And returns an `UploadResult`.
 */
export type SynapseUploadFn = (
  filePath: string,
  onProgress?: (progress: UploadProgress) => void
) => Promise<UploadResult>;

// ── Default Synapse SDK upload implementation ───────────────────────────────

/**
 * Options for creating a real Synapse uploader backed by `filecoin-pin`.
 */
export interface SynapseUploaderOptions {
  /** Wallet private key (hex, with or without 0x prefix) */
  privateKey: string;
  /** Filecoin RPC WebSocket URL */
  rpcUrl?: string;
}

/**
 * Create a `SynapseUploadFn` backed by the `filecoin-pin` SDK.
 *
 * ```ts
 * const uploader = createSynapseUploader({
 *   privateKey: "0xabc...",
 *   rpcUrl: "wss://api.calibration.node.glif.io/rpc/v1",
 * });
 * const mw = createUploadMiddleware({ synapseUpload: uploader.upload });
 * // later…
 * await uploader.cleanup();
 * ```
 */
export function createSynapseUploader(opts: SynapseUploaderOptions): {
  upload: SynapseUploadFn;
  cleanup: () => Promise<void>;
} {
  const privateKey = opts.privateKey.startsWith("0x")
    ? opts.privateKey
    : `0x${opts.privateKey}`;
  const rpcUrl =
    opts.rpcUrl ?? "wss://api.calibration.node.glif.io/rpc/v1";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let synapseInstance: any = null;

  const upload: SynapseUploadFn = async (filePath, onProgress) => {
    // Dynamic imports so `filecoin-pin` is optional at install time
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

    // Read file
    const fileData = fs.readFileSync(filePath);
    const fileSize = fileData.length;

    onProgress?.({ bytesUploaded: 0, totalBytes: fileSize, percentage: 0 });

    // Initialise Synapse
    const synapse = await initializeSynapse(
      { privateKey, rpcUrl, telemetry: { sentryInitOptions: { enabled: false } } },
      undefined // logger – uses console
    );
    synapseInstance = synapse;

    onProgress?.({ bytesUploaded: 0, totalBytes: fileSize, percentage: 10 });

    // Build CAR file
    const carBuilder = createUnixfsCarBuilder();
    const carResult = await carBuilder.buildCar(filePath, { bare: true });
    const carBytes = fs.readFileSync(carResult.carPath);

    onProgress?.({ bytesUploaded: 0, totalBytes: carBytes.length, percentage: 20 });

    // Check readiness
    await checkUploadReadiness({
      synapse,
      fileSize: carBytes.length,
      autoConfigureAllowances: true,
    });

    onProgress?.({ bytesUploaded: 0, totalBytes: carBytes.length, percentage: 30 });

    // Create storage context
    const { storage, providerInfo } = await (createStorageContext as any)(synapse);

    onProgress?.({ bytesUploaded: 0, totalBytes: carBytes.length, percentage: 40 });

    // Upload
    const rootCid = carResult.rootCid.toString();
    const uploadResult = await executeUpload(
      { synapse, storage, providerInfo },
      carBytes,
      rootCid as any,
      {
        contextId: path.basename(filePath),
        onProgress: (event: { type: string }) => {
          if (event.type === "onUploadComplete") {
            onProgress?.({ bytesUploaded: carBytes.length, totalBytes: carBytes.length, percentage: 80 });
          } else if (event.type === "onPieceAdded") {
            onProgress?.({ bytesUploaded: carBytes.length, totalBytes: carBytes.length, percentage: 90 });
          }
        },
      }
    );

    // Cleanup CAR
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

// ── Middleware factory ──────────────────────────────────────────────────────

export interface UploadMiddlewareOptions {
  /**
   * Function that uploads a file to Filecoin/IPFS.
   * Use `createSynapseUploader()` for the real SDK, or supply a stub.
   */
  synapseUpload: SynapseUploadFn;
}

/**
 * Create the Synapse upload middleware.
 */
export function createUploadMiddleware(
  options: UploadMiddlewareOptions
): Middleware {
  const { synapseUpload } = options;

    return {
    name: "upload",

    async onRequest(
      payload: RequestPayload,
      next: NextFunction
    ): Promise<void> {
      // Capture the request if not already captured by an earlier middleware (e.g. gzip, encrypt)
      if (!payload.context.metadata.capturedRequest) {
        payload.context.metadata.capturedRequest = payload.openaiRequest;
      }
      await next();
    },

    async onResponse(
      payload: ResponsePayload,
      next: NextFunction
    ): Promise<void> {
      // Pick the best available buffer.
      // encryptedBuffer and gzipBuffer already contain the combined
      // request+response from upstream middleware.
      let data: Buffer;
      let label: string;
      if (payload.context.metadata.encryptedBuffer) {
        data = payload.context.metadata.encryptedBuffer as Buffer;
        label = "encrypted";
      } else if (payload.context.metadata.gzipBuffer) {
        data = payload.context.metadata.gzipBuffer as Buffer;
        label = "gzipped";
      } else {
        // No upstream processing — build combined { request, response } payload
        const combined = {
          request: payload.context.metadata.capturedRequest ?? null,
          response: payload.openaiResponse,
        };
        data = Buffer.from(
          JSON.stringify(combined),
          "utf-8"
        );
        label = "raw JSON";
      }

      // Write to temp file
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(
        tmpDir,
        `llm-shim-${payload.context.requestId}.bin`
      );
      fs.writeFileSync(tmpFile, data);

      try {
        console.log(
          `[upload] ${payload.context.requestId} | uploading ${label} (${data.length} bytes)…`
        );

        const result = await synapseUpload(tmpFile, (p) => {
          if (p.percentage % 20 === 0) {
            console.log(
              `[upload] ${payload.context.requestId} | ${p.percentage}%`
            );
          }
        });

        payload.context.metadata.uploadCid = result.cid;
        payload.context.metadata.uploadSize = result.size;
        payload.context.metadata.uploadTimestamp = result.uploadedAt;
        if (result.dealId) {
          payload.context.metadata.uploadDealId = result.dealId;
        }

        console.log(
          `[upload] ${payload.context.requestId} | ✓ CID=${result.cid} (${result.size} bytes)`
        );
      } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }

      await next();
    },
  };
}