/**
 * CID Utility Module
 *
 * Provides CID generation functions.
 * Isolates ESM imports to allow compatibility with both CommonJS and ESM environments.
 *
 * @module cid-utils
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as rawCodec from "multiformats/codecs/raw";

/**
 * Generate a CID from data using raw codec + sha2-256 hashing.
 * Encodes data as JSON bytes first.
 */
export async function generateCID(data: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, rawCodec.code, hash);
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

// Re-export for convenience
export { CID, sha256, rawCodec };
