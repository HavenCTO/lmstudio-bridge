/**
 * CID Verification Module
 *
 * Provides cryptographic verification of content fetched from IPFS/IPLD.
 * Ensures that retrieved data matches the expected CID before processing.
 *
 * @module cid-verify
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as rawCodec from "multiformats/codecs/raw";

// ── Types ───────────────────────────────────────────────────────────────────

export type VerificationCodec = "json" | "raw" | "dag-json";

export interface VerificationResult {
  valid: boolean;
  expectedCid: string;
  computedCid: string;
  size: number;
  error?: string;
}

export interface FetchResult {
  data: Uint8Array;
  source: string;
  verification: VerificationResult;
}

export interface GatewayConfig {
  url: string;
  timeoutMs: number;
  priority: number;
}

// ── Default Gateway Configuration ───────────────────────────────────────────

export const DEFAULT_GATEWAYS: GatewayConfig[] = [
  { url: "https://ipfs.io/ipfs", timeoutMs: 30000, priority: 1 },
  { url: "https://dweb.link/ipfs", timeoutMs: 30000, priority: 2 },
  { url: "https://cloudflare-ipfs.com/ipfs", timeoutMs: 30000, priority: 3 },
  { url: "https://gateway.pinata.cloud/ipfs", timeoutMs: 30000, priority: 4 },
];

// ── Verification Functions ──────────────────────────────────────────────────

/**
 * Verify that content matches the expected CID.
 *
 * @param cid - The expected CID string
 * @param data - The content to verify
 * @param options - Verification options including codec
 * @returns Verification result with validity status
 */
export async function verifyContent(
  cid: string,
  data: Uint8Array,
  options: { codec?: VerificationCodec } = {}
): Promise<VerificationResult> {
  try {
    const parsedCid = CID.parse(cid);
    const codec = options.codec ?? "raw";

    let computedCid: CID;

    switch (codec) {
      case "json": {
        // Parse JSON and re-encode for canonical form
        const jsonCodec = await import("multiformats/codecs/json");
        const obj = JSON.parse(new TextDecoder().decode(data));
        const bytes = jsonCodec.encode(obj);
        const hash = await sha256.digest(bytes);
        computedCid = CID.create(1, jsonCodec.code, hash);
        break;
      }
      case "dag-json": {
        const dagJson = await import("@ipld/dag-json");
        const obj = dagJson.parse(new TextDecoder().decode(data));
        const bytes = dagJson.encode(obj);
        const hash = await sha256.digest(bytes);
        computedCid = CID.create(1, dagJson.code, hash);
        break;
      }
      case "raw":
      default: {
        // For raw bytes, hash directly
        const hash = await sha256.digest(data);
        computedCid = CID.create(1, rawCodec.code, hash);
        break;
      }
    }

    const computedCidString = computedCid.toString();

    return {
      valid: computedCidString === cid,
      expectedCid: cid,
      computedCid: computedCidString,
      size: data.length,
    };
  } catch (err) {
    return {
      valid: false,
      expectedCid: cid,
      computedCid: "",
      size: data.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch content from an IPFS gateway and verify it matches the expected CID.
 *
 * @param cid - The CID to fetch
 * @param gateway - The gateway URL base (e.g., "https://ipfs.io/ipfs")
 * @param options - Fetch options including timeout and codec
 * @returns Fetch result with data and verification info
 */
export async function fetchAndVerify(
  cid: string,
  gateway: string,
  options: {
    timeoutMs?: number;
    codec?: VerificationCodec;
    retries?: number;
  } = {}
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const codec = options.codec ?? "raw";
  const retries = options.retries ?? 3;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const url = `${gateway}/${cid}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/octet-stream,application/json,*/*",
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = new Uint8Array(await response.arrayBuffer());
      const verification = await verifyContent(cid, data, { codec });

      if (!verification.valid) {
        throw new Error(
          `CID verification failed: expected ${cid}, got ${verification.computedCid}`
        );
      }

      return {
        data,
        source: gateway,
        verification,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Don't retry on verification failures
      if (lastError.message.includes("CID verification failed")) {
        throw lastError;
      }

      // Exponential backoff
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${cid} after ${retries} attempts`);
}

// ── Gateway Fallback ────────────────────────────────────────────────────────

/**
 * Fetch content with automatic gateway fallback.
 * Tries multiple gateways in priority order until one succeeds and verifies.
 *
 * @param cid - The CID to fetch
 * @param gateways - Array of gateway configs (defaults to DEFAULT_GATEWAYS)
 * @param options - Fetch options
 * @returns Fetch result with successful gateway info
 */
export async function fetchWithFallback(
  cid: string,
  gateways: GatewayConfig[] = DEFAULT_GATEWAYS,
  options: {
    codec?: VerificationCodec;
    timeoutMs?: number;
  } = {}
): Promise<FetchResult> {
  // Sort by priority
  const sortedGateways = [...gateways].sort((a, b) => a.priority - b.priority);

  const errors: Array<{ gateway: string; error: string }> = [];

  for (const gateway of sortedGateways) {
    try {
      const result = await fetchAndVerify(cid, gateway.url, {
        timeoutMs: gateway.timeoutMs,
        codec: options.codec,
      });

      // If we successfully verified, return the result
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push({ gateway: gateway.url, error: errorMsg });

      // Don't try other gateways on verification failure - the data is corrupted
      if (errorMsg.includes("CID verification failed")) {
        throw new Error(
          `Content verification failed for ${cid} at ${gateway.url}: ${errorMsg}`
        );
      }
    }
  }

  // All gateways failed
  const errorSummary = errors
    .map((e) => `${e.gateway}: ${e.error}`)
    .join("; ");
  throw new Error(
    `Failed to fetch ${cid} from all gateways. Errors: ${errorSummary}`
  );
}

// ── Batch Operations ────────────────────────────────────────────────────────

export interface BatchFetchResult {
  results: Map<string, FetchResult>;
  failures: Map<string, Error>;
  totalSize: number;
}

/**
 * Fetch multiple CIDs with verification, using gateway fallback for each.
 *
 * @param cids - Array of CIDs to fetch
 * @param gateways - Gateway configurations
 * @param options - Fetch options
 * @returns Batch fetch results
 */
export async function fetchBatchWithVerification(
  cids: string[],
  gateways: GatewayConfig[] = DEFAULT_GATEWAYS,
  options: {
    codec?: VerificationCodec;
    timeoutMs?: number;
    concurrency?: number;
  } = {}
): Promise<BatchFetchResult> {
  const concurrency = options.concurrency ?? 3;
  const results = new Map<string, FetchResult>();
  const failures = new Map<string, Error>();

  // Process in batches to limit concurrency
  for (let i = 0; i < cids.length; i += concurrency) {
    const batch = cids.slice(i, i + concurrency);
    const batchPromises = batch.map(async (cid) => {
      try {
        const result = await fetchWithFallback(cid, gateways, options);
        results.set(cid, result);
      } catch (err) {
        failures.set(
          cid,
          err instanceof Error ? err : new Error(String(err))
        );
      }
    });

    await Promise.all(batchPromises);
  }

  const totalSize = Array.from(results.values()).reduce(
    (sum, r) => sum + r.data.length,
    0
  );

  return { results, failures, totalSize };
}

// ── IPLD DAG Traversal with Verification ────────────────────────────────────

export interface TraversalStep {
  cid: string;
  path: string;
  verified: boolean;
  data?: Uint8Array;
  error?: string;
}

/**
 * Traverse an IPLD DAG, verifying each node along the path.
 *
 * @param rootCid - The root CID of the DAG
 * @param path - IPLD path to traverse (e.g., "request/messages/0/content")
 * @param gateways - Gateway configurations
 * @returns Array of traversal steps with verification results
 */
export async function traverseVerified(
  rootCid: string,
  path: string,
  gateways: GatewayConfig[] = DEFAULT_GATEWAYS
): Promise<TraversalStep[]> {
  const steps: TraversalStep[] = [];
  const pathParts = path.split("/").filter((p) => p.length > 0);

  let currentCid = rootCid;
  let currentPath = "";

  // Fetch root
  try {
    const result = await fetchWithFallback(currentCid, gateways, {
      codec: "dag-json",
    });

    steps.push({
      cid: currentCid,
      path: currentPath,
      verified: result.verification.valid,
      data: result.data,
    });

    // Parse as dag-json and traverse path
    const dagJson = await import("@ipld/dag-json");
    let current = dagJson.parse(new TextDecoder().decode(result.data));

    for (const part of pathParts) {
      if (current === null || typeof current !== "object") {
        steps.push({
          cid: currentCid,
          path: currentPath,
          verified: false,
          error: `Cannot traverse path "${part}" on non-object`,
        });
        return steps;
      }

      if (!(part in current)) {
        steps.push({
          cid: currentCid,
          path: currentPath,
          verified: false,
          error: `Path "${part}" not found`,
        });
        return steps;
      }

      current = (current as Record<string, unknown>)[part];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      // If current is a CID link, fetch and verify it
      if (
        current !== null &&
        typeof current === "object" &&
        "/" in current
      ) {
        const linkCid = (current as Record<string, string>)["/"];
        currentCid = linkCid;

        try {
          const linkResult = await fetchWithFallback(linkCid, gateways, {
            codec: "dag-json",
          });

          steps.push({
            cid: linkCid,
            path: currentPath,
            verified: linkResult.verification.valid,
            data: linkResult.data,
          });

          current = dagJson.parse(new TextDecoder().decode(linkResult.data));
        } catch (err) {
          steps.push({
            cid: linkCid,
            path: currentPath,
            verified: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return steps;
        }
      }
    }
  } catch (err) {
    steps.push({
      cid: currentCid,
      path: currentPath,
      verified: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return steps;
}
