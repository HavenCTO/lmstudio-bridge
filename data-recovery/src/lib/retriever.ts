/**
 * IPFS/Synapse Retrieval Module — V2 Architecture
 *
 * Handles retrieval of CAR files from IPFS gateways and Synapse/Filecoin storage.
 * Format-agnostic — retrieves raw CAR bytes for extraction by car-extractor.
 */

import { CID } from "multiformats/cid";
import { CarReader } from "@ipld/car";
import * as fs from "fs";
import * as path from "path";
import { RetrievalResult, SynapseRetrievalOptions } from "../types";

// ── IPFS Gateway Retrieval ──────────────────────────────────────────────────

export interface GatewayRetrievalOptions {
  /** IPFS gateway URL (default: Cloudflare IPFS gateway) */
  gatewayUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Retry attempts on failure */
  retries?: number;
}

const DEFAULT_GATEWAYS = [
  "https://ipfs.io",
  "https://cloudflare-ipfs.com",
  "https://dweb.link",
  "https://gateway.pinata.cloud",
];

/**
 * Retrieve a CAR file from an IPFS gateway by CID
 */
export async function retrieveFromGateway(
  cid: string | CID,
  options: GatewayRetrievalOptions = {}
): Promise<RetrievalResult> {
  const cidString = typeof cid === "string" ? cid : cid.toString();
  const parsedCid = typeof cid === "string" ? CID.parse(cid) : cid;

  const timeout = options.timeout ?? 30000;
  const retries = options.retries ?? 3;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const currentGateway = options.gatewayUrl ?? DEFAULT_GATEWAYS[attempt % DEFAULT_GATEWAYS.length];
      const url = `${currentGateway}/ipfs/${cidString}`;

      console.log(`[retrieval] Attempt ${attempt + 1}/${retries}: Fetching from ${currentGateway}...`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const carBytes = new Uint8Array(arrayBuffer);

      return {
        cid: parsedCid,
        carBytes,
        blockCount: 0, // Will be counted during CAR parsing
        totalSize: carBytes.length,
        retrievedAt: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`[retrieval] Attempt ${attempt + 1} failed: ${lastError.message}`);

      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(
    `Failed to retrieve CID ${cidString} from IPFS after ${retries} attempts. Last error: ${lastError?.message}`
  );
}

/**
 * Retrieve multiple CIDs from IPFS gateways with parallel fetching
 */
export async function retrieveMultipleFromGateway(
  cids: (string | CID)[],
  options: GatewayRetrievalOptions = {}
): Promise<RetrievalResult[]> {
  console.log(`[retrieval] Fetching ${cids.length} CIDs from IPFS...`);

  const results = await Promise.all(
    cids.map(async (cid) => {
      try {
        return await retrieveFromGateway(cid, options);
      } catch (error) {
        const cidStr = typeof cid === "string" ? cid : cid.toString();
        console.error(`[retrieval] Failed to fetch ${cidStr}:`, error);
        throw error;
      }
    })
  );

  console.log(`[retrieval] Successfully fetched ${results.length} CIDs`);
  return results;
}

// ── Synapse/Filecoin Retrieval ──────────────────────────────────────────────

/**
 * Retrieve data from Synapse/Filecoin network
 */
export async function retrieveFromSynapse(
  cid: string | CID,
  options: SynapseRetrievalOptions = {}
): Promise<RetrievalResult> {
  const cidString = typeof cid === "string" ? cid : cid.toString();

  console.log(`[retrieval] Attempting Synapse retrieval for CID ${cidString}...`);

  try {
    const { createRetriever } = await import("filecoin-pin/retrieval" as any);

    const rpcUrl = options.rpcUrl ?? "https://api.calibration.node.glif.io/rpc/v1";
    const privateKey = options.privateKey;

    const retriever = (createRetriever as any)({ rpcUrl, privateKey });

    console.log(`[retrieval] Downloading from Filecoin network...`);

    const result = await retriever.retrieve(cidString, {
      onProgress: (progress: number) => {
        console.log(`[retrieval] Download progress: ${Math.round(progress)}%`);
      },
    });

    return {
      cid: typeof cid === "string" ? CID.parse(cid) : cid,
      carBytes: result.carBytes,
      blockCount: result.blockCount,
      totalSize: result.carBytes.length,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[retrieval] Synapse retrieval failed: ${errorMessage}`);
    console.log("[retrieval] Falling back to IPFS gateway...");

    return retrieveFromGateway(cid, {
      gatewayUrl: options.ipfsGateway,
    });
  }
}

// ── Local CAR File Loading ──────────────────────────────────────────────────

/**
 * Load a CAR file from local filesystem
 */
export async function loadLocalCarFile(filePath: string): Promise<RetrievalResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CAR file not found: ${filePath}`);
  }

  const carBytes = new Uint8Array(fs.readFileSync(filePath));

  // Parse CAR to get root CID using standard CarReader
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();

  if (roots.length === 0) {
    throw new Error("CAR file has no root CID");
  }

  const rootCid = roots[0];

  return {
    cid: rootCid,
    carBytes,
    blockCount: 0, // Will be counted during parsing
    totalSize: carBytes.length,
    retrievedAt: new Date().toISOString(),
  };
}

/**
 * Load multiple CAR files from local filesystem
 */
export async function loadLocalCarFiles(filePaths: string[]): Promise<RetrievalResult[]> {
  return Promise.all(
    filePaths.map(async (filePath) => {
      try {
        return await loadLocalCarFile(filePath);
      } catch (error) {
        console.error(`[retrieval] Failed to load ${filePath}:`, error);
        throw error;
      }
    })
  );
}

// ── Batch Retrieval Orchestrator ────────────────────────────────────────────

export interface BatchRetrievalOptions {
  /** Primary retrieval method */
  method?: "gateway" | "synapse" | "local";
  /** Fallback methods in order */
  fallbackMethods?: ("gateway" | "synapse" | "local")[];
  /** IPFS gateway URL */
  ipfsGateway?: string;
  /** Output directory for raw CAR files */
  cacheDir?: string;
  /** Save raw CAR files to cache */
  cacheResults?: boolean;
}

/**
 * Batch retrieval with automatic fallback between methods
 */
export async function batchRetrieve(
  inputs: Array<{ cid: string; type: "cid" } | { filePath: string; type: "local" }>,
  options: BatchRetrievalOptions = {}
): Promise<Map<string, RetrievalResult>> {
  const method = options.method ?? "gateway";
  const fallbacks = options.fallbackMethods ?? ["gateway"];
  const results = new Map<string, RetrievalResult>();

  if (options.cacheResults && options.cacheDir) {
    fs.mkdirSync(options.cacheDir, { recursive: true });
  }

  for (const input of inputs) {
    const key = input.type === "cid" ? input.cid : input.filePath;
    console.log(`\n[retrieval] Processing: ${key}`);

    const retrievalMethods: Array<{
      name: string;
      fn: () => Promise<RetrievalResult>;
    }> = [];

    const allMethods = [method, ...fallbacks];

    for (const m of allMethods) {
      switch (m) {
        case "gateway":
          if (input.type === "cid") {
            retrievalMethods.push({
              name: "IPFS Gateway",
              fn: () => retrieveFromGateway(input.cid, { gatewayUrl: options.ipfsGateway }),
            });
          }
          break;
        case "synapse":
          if (input.type === "cid") {
            retrievalMethods.push({
              name: "Synapse",
              fn: () => retrieveFromSynapse(input.cid, { ipfsGateway: options.ipfsGateway }),
            });
          }
          break;
        case "local":
          if (input.type === "local") {
            retrievalMethods.push({
              name: "Local File",
              fn: () => loadLocalCarFile(input.filePath),
            });
          }
          break;
      }
    }

    let success = false;
    for (const { name, fn } of retrievalMethods) {
      try {
        console.log(`[retrieval] Trying ${name}...`);
        const result = await fn();
        results.set(key, result);

        if (options.cacheResults && options.cacheDir && input.type === "cid") {
          const cachePath = path.join(options.cacheDir, `${result.cid.toString()}.car`);
          fs.writeFileSync(cachePath, result.carBytes);
          console.log(`[retrieval] Cached to: ${cachePath}`);
        }

        success = true;
        break;
      } catch (error) {
        console.warn(`[retrieval] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!success) {
      throw new Error(`All retrieval methods failed for ${key}`);
    }
  }

  return results;
}
