/**
 * Gzip compression middleware.
 *
 * Captures the OpenAI request during `onRequest` and combines it with
 * the response during `onResponse` into a single JSON payload:
 *
 *   { "request": <OpenAIChatCompletionRequest>, "response": <OpenAIChatCompletionResponse> }
 *
 * The combined payload is then gzip-compressed.  This works transparently
 * with all OpenAI content formats including multi-part messages that carry
 * inline base64 images (`image_url` content parts) — `JSON.stringify`
 * serialises them natively and gzip compresses the base64 data effectively.
 *
 * Stores the compressed buffer in `context.metadata` so downstream
 * middleware (encrypt, upload) can operate on the smaller payload.
 *
 * Configuration:
 *   --gzip              Enable gzip compression
 *   --gzip-level <0-9>  Compression level (default 6)
 */

import { promisify } from "util";
import { gzip, gunzip, constants as zlibConstants } from "zlib";
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from "../types";

const gzipAsync = promisify(gzip);

export interface GzipMiddlewareOptions {
  /** zlib compression level 0-9 (default 6) */
  level?: number;
}

/**
 * Create a gzip middleware instance.
 *
 * During the request phase the middleware stores the original OpenAI
 * request in `context.metadata.capturedRequest`.
 *
 * During the response phase the combined `{ request, response }` JSON
 * is gzip-compressed.  If the request contains `image_url` content
 * parts with inline base64 data they are included as-is — gzip handles
 * them well.
 *
 * After this middleware runs the following metadata keys are set:
 *   - `capturedRequest`  – the original OpenAI request object
 *   - `gzipBuffer`       – the compressed Buffer
 *   - `gzipOriginalSize` – byte-length before compression
 *   - `gzipSize`         – byte-length after compression
 *   - `contentEncoding`  – "gzip"
 */
export function createGzipMiddleware(
  options?: GzipMiddlewareOptions
): Middleware {
  const level = options?.level ?? 6;

    return {
    name: "gzip",

    async onRequest(
      payload: RequestPayload,
      next: NextFunction
    ): Promise<void> {
      // Capture the request so it can be combined with the response later
      payload.context.metadata.capturedRequest = payload.openaiRequest;
      await next();
    },

    async onResponse(
      payload: ResponsePayload,
      next: NextFunction
    ): Promise<void> {
      // Build a combined { request, response } payload
      const combined = {
        request: payload.context.metadata.capturedRequest ?? null,
        response: payload.openaiResponse,
      };
      const json = JSON.stringify(combined);
      const originalSize = Buffer.byteLength(json, "utf-8");

      const compressed = await gzipAsync(json, { level });

      payload.context.metadata.gzipBuffer = compressed;
      payload.context.metadata.gzipOriginalSize = originalSize;
      payload.context.metadata.gzipSize = compressed.length;
      payload.context.metadata.contentEncoding = "gzip";

      console.log(
        `[gzip] ${payload.context.requestId} | ${originalSize} → ${compressed.length} bytes (${((1 - compressed.length / originalSize) * 100).toFixed(1)}% reduction)`
      );

      await next();
    },
  };
}