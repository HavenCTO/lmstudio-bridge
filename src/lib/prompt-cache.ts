/**
 * System Prompt Cache Module
 *
 * Maintains a persistent cache of common system prompts → CID mappings.
 * Enables deduplication of system prompts across conversations.
 *
 * Falls back to in-memory storage when better-sqlite3 is not available.
 *
 * @module prompt-cache
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as path from "path";
import * as fs from "fs";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PromptCacheEntry {
  /** The content hash used as lookup key */
  contentHash: string;
  /** The CID of the prompt */
  cid: string;
  /** First seen timestamp */
  createdAt: number;
  /** Last accessed timestamp */
  lastAccessedAt: number;
  /** Number of times this prompt was reused */
  reuseCount: number;
  /** Size of the prompt content in bytes */
  contentSize: number;
}

export interface PromptCacheStats {
  totalEntries: number;
  totalContentSize: number;
  totalBytesSaved: number;
  averageReuseCount: number;
}

export interface PromptCache {
  /** Get CID for a prompt if it exists in cache */
  get(promptContent: string): Promise<CID | null>;
  /** Add a new prompt → CID mapping */
  set(promptContent: string, cid: CID): Promise<void>;
  /** Get cache statistics */
  getStats(): Promise<PromptCacheStats>;
  /** Clear all entries */
  clear(): Promise<void>;
  /** Remove stale entries */
  cleanup(maxAgeMs: number): Promise<number>;
  /** Close database connection */
  close(): Promise<void>;
}

export interface PromptCacheOptions {
  /** Database file path. Defaults to ./data/prompt-cache.db */
  dbPath?: string;
  /** Maximum number of entries to keep in cache */
  maxEntries?: number;
  /** Enable WAL mode */
  enableWAL?: boolean;
  /** Force in-memory mode */
  inMemory?: boolean;
}

// ── In-Memory Implementation ────────────────────────────────────────────────

function createInMemoryPromptCache(maxEntries: number): PromptCache {
  const cache = new Map<string, PromptCacheEntry>();

  return {
    async get(promptContent: string): Promise<CID | null> {
      const contentHash = await hashPrompt(promptContent);
      const entry = cache.get(contentHash);
      
      if (!entry) return null;

      // Update access stats
      entry.lastAccessedAt = Date.now();
      entry.reuseCount++;

      try {
        return CID.parse(entry.cid);
      } catch {
        return null;
      }
    },

    async set(promptContent: string, cid: CID): Promise<void> {
      const contentHash = await hashPrompt(promptContent);
      const contentSize = new TextEncoder().encode(promptContent).length;
      const now = Date.now();

      // Evict oldest entries if at capacity
      if (cache.size >= maxEntries) {
        const entries = Array.from(cache.entries());
        entries.sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
        const toRemove = Math.floor(maxEntries * 0.1);
        for (let i = 0; i < toRemove; i++) {
          cache.delete(entries[i][0]);
        }
      }

      cache.set(contentHash, {
        contentHash,
        cid: cid.toString(),
        createdAt: now,
        lastAccessedAt: now,
        reuseCount: 0,
        contentSize,
      });
    },

    async getStats(): Promise<PromptCacheStats> {
      let totalSize = 0;
      let totalSaved = 0;
      
      for (const entry of cache.values()) {
        totalSize += entry.contentSize;
        totalSaved += entry.contentSize * entry.reuseCount;
      }

      return {
        totalEntries: cache.size,
        totalContentSize: totalSize,
        totalBytesSaved: totalSaved,
        averageReuseCount: cache.size > 0 ? totalSaved / Math.max(totalSize, 1) : 0,
      };
    },

    async clear(): Promise<void> {
      cache.clear();
    },

    async cleanup(maxAgeMs: number): Promise<number> {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;

      for (const [hash, entry] of cache) {
        if (entry.lastAccessedAt < cutoff) {
          cache.delete(hash);
          removed++;
        }
      }

      return removed;
    },

    async close(): Promise<void> {
      cache.clear();
    },
  };
}

// ── SQLite Implementation ───────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS prompt_cache (
    content_hash TEXT PRIMARY KEY,
    cid TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    reuse_count INTEGER NOT NULL DEFAULT 0,
    content_size INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_last_accessed ON prompt_cache(last_accessed_at);
  CREATE INDEX IF NOT EXISTS idx_reuse_count ON prompt_cache(reuse_count);
`;

function createSQLitePromptCache(options: PromptCacheOptions): PromptCache {
  // Dynamic import to avoid loading better-sqlite3 when not needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  
  const dbPath = options.dbPath ?? path.resolve("./data/prompt-cache.db");
  const maxEntries = options.maxEntries ?? 10000;
  const enableWAL = options.enableWAL ?? true;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open database
  const db = new Database(dbPath);

  if (enableWAL) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }

  // Initialize schema
  db.exec(SCHEMA);

  // Prepare statements
  const getStmt = db.prepare("SELECT * FROM prompt_cache WHERE content_hash = ?");
  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO prompt_cache (content_hash, cid, created_at, last_accessed_at, reuse_count, content_size) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const updateAccessStmt = db.prepare(
    "UPDATE prompt_cache SET last_accessed_at = ?, reuse_count = reuse_count + 1 WHERE content_hash = ?"
  );
  const statsStmt = db.prepare(
    "SELECT COUNT(*) as count, SUM(content_size) as total_size, SUM(content_size * reuse_count) as saved FROM prompt_cache"
  );
  const clearStmt = db.prepare("DELETE FROM prompt_cache");
  const cleanupStmt = db.prepare("DELETE FROM prompt_cache WHERE last_accessed_at < ?");
  const countStmt = db.prepare("SELECT COUNT(*) as count FROM prompt_cache");
  const lruDeleteStmt = db.prepare(
    "DELETE FROM prompt_cache WHERE content_hash IN (SELECT content_hash FROM prompt_cache ORDER BY last_accessed_at ASC LIMIT ?)"
  );

  const cache: PromptCache = {
    async get(promptContent: string): Promise<CID | null> {
      const contentHash = await hashPrompt(promptContent);
      const row = getStmt.get(contentHash) as
        | {
            content_hash: string;
            cid: string;
            created_at: number;
            last_accessed_at: number;
            reuse_count: number;
            content_size: number;
          }
        | undefined;

      if (!row) return null;

      // Update access statistics
      updateAccessStmt.run(Date.now(), contentHash);

      try {
        return CID.parse(row.cid);
      } catch {
        return null;
      }
    },

    async set(promptContent: string, cid: CID): Promise<void> {
      const contentHash = await hashPrompt(promptContent);
      const contentSize = new TextEncoder().encode(promptContent).length;
      const now = Date.now();

      // Check if we need to evict entries
      const count = (countStmt.get() as { count: number }).count;
      if (count >= maxEntries) {
        // Remove oldest 10% of entries
        const toRemove = Math.floor(maxEntries * 0.1);
        lruDeleteStmt.run(toRemove);
      }

      insertStmt.run(contentHash, cid.toString(), now, now, 0, contentSize);
    },

    async getStats(): Promise<PromptCacheStats> {
      const row = statsStmt.get() as {
        count: number;
        total_size: number;
        saved: number;
      };

      return {
        totalEntries: row.count ?? 0,
        totalContentSize: row.total_size ?? 0,
        totalBytesSaved: row.saved ?? 0,
        averageReuseCount: row.count > 0 ? (row.saved ?? 0) / Math.max(row.total_size ?? 1, 1) : 0,
      };
    },

    async clear(): Promise<void> {
      clearStmt.run();
    },

    async cleanup(maxAgeMs: number): Promise<number> {
      const cutoff = Date.now() - maxAgeMs;
      const result = cleanupStmt.run(cutoff);
      return result.changes;
    },

    async close(): Promise<void> {
      db.close();
    },
  };

  return cache;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Hash prompt content for use as cache key
 */
async function hashPrompt(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256.digest(bytes);
  return Buffer.from(hash.digest).toString("hex");
}

export function createPromptCache(options?: PromptCacheOptions): PromptCache {
  // Use in-memory cache if explicitly requested or if better-sqlite3 is not available
  if (options?.inMemory) {
    return createInMemoryPromptCache(options?.maxEntries ?? 10000);
  }

  try {
    return createSQLitePromptCache(options ?? {});
  } catch {
    console.log("[prompt-cache] SQLite not available, using in-memory cache");
    return createInMemoryPromptCache(options?.maxEntries ?? 10000);
  }
}

// ── Singleton Instance ──────────────────────────────────────────────────────

let globalPromptCache: PromptCache | null = null;

export function getGlobalPromptCache(options?: PromptCacheOptions): PromptCache {
  if (!globalPromptCache) {
    globalPromptCache = createPromptCache(options);
  }
  return globalPromptCache;
}

export function resetGlobalPromptCache(): void {
  if (globalPromptCache) {
    globalPromptCache.close().catch(console.error);
    globalPromptCache = null;
  }
}

// ── Helper Functions ────────────────────────────────────────────────────────

/**
 * Check if a message is a system prompt
 */
export function isSystemPrompt(message: { role: string; content: unknown }): boolean {
  return message.role === "system" && typeof message.content === "string";
}

/**
 * Extract system prompt from conversation messages
 */
export function extractSystemPrompt(
  messages: Array<{ role: string; content: unknown }>
): string | null {
  if (messages.length > 0 && isSystemPrompt(messages[0])) {
    return messages[0].content as string;
  }
  return null;
}

/**
 * Calculate bytes saved by prompt deduplication
 */
export function calculateBytesSaved(
  originalSize: number,
  reuseCount: number
): number {
  return originalSize * reuseCount;
}
