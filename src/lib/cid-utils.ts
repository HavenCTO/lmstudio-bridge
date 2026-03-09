/**
 * CID Utility Module
 *
 * Provides CID generation and verification functions.
 * Isolates ESM imports to allow compatibility with both CommonJS and ESM environments.
 *
 * @module cid-utils
 */

import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import { sha256 } from "multiformats/hashes/sha2";
import * as rawCodec from "multiformats/codecs/raw";

/**
 * Generate a CID from data using dag-json codec
 * Uses sha2-256 hashing
 */
export async function generateCID(data: unknown): Promise<string> {
  const bytes = dagJson.encode(data);
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, hash);
  return cid.toString();
}

/**
 * Generate a CID from raw bytes
 * Uses raw codec with sha2-256 hashing
 */
export async function generateRawCID(data: Uint8Array): Promise<string> {
  const hash = await sha256.digest(data);
  const cid = CID.create(1, rawCodec.code, hash);
  return cid.toString();
}

/**
 * Verify that content matches the expected CID
 */
export async function verifyContent(cid: string, data: Uint8Array): Promise<boolean> {
  const { CID } = await import("multiformats/cid");
  const { sha256 } = await import("multiformats/hashes/sha2");
  const rawCodec = await import("multiformats/codecs/raw");
  
  const hash = await sha256.digest(data);
  const computedCid = CID.create(1, rawCodec.code, hash);
  return computedCid.toString() === cid;
}

/**
 * Fetch content from IPFS gateway and verify it matches expected CID
 */
export async function fetchAndVerify(
  cid: string,
  gateway: string = "https://ipfs.io/ipfs"
): Promise<{ data: Uint8Array; verified: boolean }> {
  const url = `${gateway}/${cid}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = new Uint8Array(await response.arrayBuffer());
  const verified = await verifyContent(cid, data);
  
  return { data, verified };
}

// Re-export for convenience
export { CID, dagJson, sha256, rawCodec };
