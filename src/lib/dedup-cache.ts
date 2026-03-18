/**
 * Content-Hash Deduplication Cache
 *
 * Simple in-memory Set of content hashes. Prevents re-archiving identical
 * conversations. Replaces the old cid-cache.ts (SQLite) and prompt-cache.ts.
 *
 * @module dedup-cache
 */

import { sha256 } from "multiformats/hashes/sha2";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DedupCache {
  /** Check if content hash has been seen */
  has(contentHash: string): boolean;
  /** Add a content hash */
  add(contentHash: string): void;
  /** Number of entries */
  size(): number;
  /** Clear all entries */
  clear(): void;
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a dedup cache.
 * Simple in-memory Set — no SQLite, no TTL, no deal status tracking.
 *
 * @param maxEntries - Maximum entries before LRU eviction (default: 50000)
 */
export function createDedupCache(maxEntries: number = 50000): DedupCache {
  // Use a Map to maintain insertion order for LRU eviction
  const entries = new Map<string, true>();

  function evictOldest(): void {
    // Delete oldest 10% when at capacity
    const toDelete = Math.max(1, Math.floor(maxEntries * 0.1));
    let deleted = 0;
    for (const key of entries.keys()) {
      if (deleted >= toDelete) break;
      entries.delete(key);
      deleted++;
    }
  }

  return {
    has(contentHash: string): boolean {
      return entries.has(contentHash);
    },

    add(contentHash: string): void {
      if (entries.has(contentHash)) {
        // Move to end (most recently used)
        entries.delete(contentHash);
      } else if (entries.size >= maxEntries) {
        evictOldest();
      }
      entries.set(contentHash, true);
    },

    size(): number {
      return entries.size;
    },

    clear(): void {
      entries.clear();
    },
  };
}

// ── Content Hash Function ───────────────────────────────────────────────────

/**
 * Compute a content hash for deduplication.
 * SHA-256 of canonical JSON: { model, messages, response.choices }.
 *
 * This is the ONLY hash computed on the hot path (if dedup is enabled).
 * It does NOT require building any IPLD structures.
 */
export async function computeContentHash(
  request: { model?: string; messages?: unknown[] },
  response: { choices?: unknown[] }
): Promise<string> {
  const canonical = JSON.stringify({
    model: request.model,
    messages: request.messages,
    choices: response.choices,
  });

  const bytes = new TextEncoder().encode(canonical);
  const hash = await sha256.digest(bytes);

  // Return hex string of the hash digest
  return Array.from(hash.digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
