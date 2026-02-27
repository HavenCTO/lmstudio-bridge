/**
 * CID Cache Module
 *
 * Implements a persistent SQLite-based cache to prevent re-uploading
 * identical content to Filecoin. Provides deduplication at the CID level
 * with metadata tracking for deal status and TTL-based cleanup.
 *
 * Falls back to in-memory storage when better-sqlite3 is not available.
 *
 * @module cid-cache
 */

import * as path from "path";
import * as fs from "fs";

// ── Types ───────────────────────────────────────────────────────────────────

export type DealStatus = "pending" | "active" | "expired" | "failed";

export interface CIDCacheEntry {
  cid: string;
  size: number;
  uploadedAt: number;
  dealStatus: DealStatus;
  mimeType: string;
}

export interface CIDCacheStats {
  totalEntries: number;
  totalSize: number;
  byStatus: Record<DealStatus, number>;
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface CIDCache {
  /** Check if CID exists in cache */
  has(cid: string): Promise<boolean>;
  /** Get entry metadata by CID */
  get(cid: string): Promise<CIDCacheEntry | null>;
  /** Add new CID entry to cache */
  add(cid: string, metadata: Omit<CIDCacheEntry, "cid">): Promise<void>;
  /** Add multiple entries in batch */
  addBatch(entries: CIDCacheEntry[]): Promise<void>;
  /** Update deal status for a CID */
  updateDealStatus(cid: string, status: DealStatus): Promise<void>;
  /** Get total number of cached entries */
  size(): Promise<number>;
  /** Get cache statistics */
  getStats(): Promise<CIDCacheStats>;
  /** Clear all entries (use with caution) */
  clear(): Promise<void>;
  /** Remove stale entries older than TTL */
  cleanup(ttlMs: number): Promise<number>;
  /** Close database connection */
  close(): Promise<void>;
}

export interface CIDCacheOptions {
  /** Database file path. Defaults to ./data/cid-cache.db */
  dbPath?: string;
  /** Default TTL for entries in milliseconds. Defaults to 90 days. */
  defaultTtlMs?: number;
  /** Enable WAL mode for better concurrency */
  enableWAL?: boolean;
  /** Force in-memory mode (no SQLite persistence) */
  inMemory?: boolean;
}

// ── In-Memory Implementation ────────────────────────────────────────────────

function createInMemoryCache(defaultTtlMs: number): CIDCache {
  const cache = new Map<string, CIDCacheEntry>();

  return {
    async has(cid: string): Promise<boolean> {
      return cache.has(cid);
    },

    async get(cid: string): Promise<CIDCacheEntry | null> {
      return cache.get(cid) ?? null;
    },

    async add(cid: string, metadata: Omit<CIDCacheEntry, "cid">): Promise<void> {
      cache.set(cid, { cid, ...metadata });
    },

    async addBatch(entries: CIDCacheEntry[]): Promise<void> {
      for (const entry of entries) {
        cache.set(entry.cid, entry);
      }
    },

    async updateDealStatus(cid: string, status: DealStatus): Promise<void> {
      const entry = cache.get(cid);
      if (entry) {
        entry.dealStatus = status;
      }
    },

    async size(): Promise<number> {
      return cache.size;
    },

    async getStats(): Promise<CIDCacheStats> {
      let totalSize = 0;
      const byStatus: Record<DealStatus, number> = {
        pending: 0,
        active: 0,
        expired: 0,
        failed: 0,
      };

      for (const entry of cache.values()) {
        totalSize += entry.size;
        byStatus[entry.dealStatus]++;
      }

      return {
        totalEntries: cache.size,
        totalSize,
        byStatus,
      };
    },

    async clear(): Promise<void> {
      cache.clear();
    },

    async cleanup(ttlMs: number = defaultTtlMs): Promise<number> {
      const cutoff = Date.now() - ttlMs;
      let removed = 0;

      for (const [cid, entry] of cache) {
        if (entry.uploadedAt < cutoff) {
          cache.delete(cid);
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
  CREATE TABLE IF NOT EXISTS cid_cache (
    cid TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL,
    deal_status TEXT NOT NULL DEFAULT 'pending',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'
  );

  CREATE INDEX IF NOT EXISTS idx_deal_status ON cid_cache(deal_status);
  CREATE INDEX IF NOT EXISTS idx_uploaded_at ON cid_cache(uploaded_at);
`;

function createSQLiteCache(options: CIDCacheOptions): CIDCache {
  // Dynamic import to avoid loading better-sqlite3 when not needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  
  const dbPath = options.dbPath ?? path.resolve("./data/cid-cache.db");
  const defaultTtlMs = options.defaultTtlMs ?? 90 * 24 * 60 * 60 * 1000;
  const enableWAL = options.enableWAL ?? true;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open database with better-sqlite3 (synchronous API)
  const db = new Database(dbPath);

  // Enable WAL mode for better performance and concurrency
  if (enableWAL) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }

  // Initialize schema
  db.exec(SCHEMA);

  // Prepare statements for reuse
  const hasStmt = db.prepare("SELECT 1 FROM cid_cache WHERE cid = ?");
  const getStmt = db.prepare("SELECT * FROM cid_cache WHERE cid = ?");
  const addStmt = db.prepare(
    "INSERT OR REPLACE INTO cid_cache (cid, size, uploaded_at, deal_status, mime_type) VALUES (?, ?, ?, ?, ?)"
  );
  const updateStatusStmt = db.prepare(
    "UPDATE cid_cache SET deal_status = ? WHERE cid = ?"
  );
  const countStmt = db.prepare("SELECT COUNT(*) as count FROM cid_cache");
  const sizeSumStmt = db.prepare("SELECT COALESCE(SUM(size), 0) as total FROM cid_cache");
  const statsStmt = db.prepare(
    "SELECT deal_status, COUNT(*) as count FROM cid_cache GROUP BY deal_status"
  );
  const clearStmt = db.prepare("DELETE FROM cid_cache");
  const cleanupStmt = db.prepare(
    "DELETE FROM cid_cache WHERE uploaded_at < ?"
  );

  const cache: CIDCache = {
    async has(cid: string): Promise<boolean> {
      const result = hasStmt.get(cid);
      return result !== undefined;
    },

    async get(cid: string): Promise<CIDCacheEntry | null> {
      const row = getStmt.get(cid) as
        | {
            cid: string;
            size: number;
            uploaded_at: number;
            deal_status: string;
            mime_type: string;
          }
        | undefined;

      if (!row) return null;

      return {
        cid: row.cid,
        size: row.size,
        uploadedAt: row.uploaded_at,
        dealStatus: row.deal_status as DealStatus,
        mimeType: row.mime_type,
      };
    },

    async add(
      cid: string,
      metadata: Omit<CIDCacheEntry, "cid">
    ): Promise<void> {
      addStmt.run(
        cid,
        metadata.size,
        metadata.uploadedAt,
        metadata.dealStatus,
        metadata.mimeType
      );
    },

    async addBatch(entries: CIDCacheEntry[]): Promise<void> {
      const insert = db.transaction((items: unknown) => {
        for (const item of items as CIDCacheEntry[]) {
          addStmt.run(
            item.cid,
            item.size,
            item.uploadedAt,
            item.dealStatus,
            item.mimeType
          );
        }
      });
      insert(entries);
    },

    async updateDealStatus(cid: string, status: DealStatus): Promise<void> {
      updateStatusStmt.run(status, cid);
    },

    async size(): Promise<number> {
      const result = countStmt.get() as { count: number };
      return result.count;
    },

    async getStats(): Promise<CIDCacheStats> {
      const totalEntries = (countStmt.get() as { count: number }).count;
      const totalSize = (sizeSumStmt.get() as { total: number }).total;
      const statusRows = statsStmt.all() as Array<{
        deal_status: string;
        count: number;
      }>;

      const byStatus: Record<DealStatus, number> = {
        pending: 0,
        active: 0,
        expired: 0,
        failed: 0,
      };

      for (const row of statusRows) {
        byStatus[row.deal_status as DealStatus] = row.count;
      }

      return { totalEntries, totalSize, byStatus };
    },

    async clear(): Promise<void> {
      clearStmt.run();
    },

    async cleanup(ttlMs: number = defaultTtlMs): Promise<number> {
      const cutoff = Date.now() - ttlMs;
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

export function createCIDCache(options?: CIDCacheOptions): CIDCache {
  // Use in-memory cache if explicitly requested or if better-sqlite3 is not available
  if (options?.inMemory) {
    return createInMemoryCache(options?.defaultTtlMs ?? 90 * 24 * 60 * 60 * 1000);
  }

  try {
    // Try to use SQLite
    return createSQLiteCache(options ?? {});
  } catch {
    // Fall back to in-memory if SQLite is not available
    console.log("[cid-cache] SQLite not available, using in-memory cache");
    return createInMemoryCache(options?.defaultTtlMs ?? 90 * 24 * 60 * 60 * 1000);
  }
}

// CID generation functions are available in cid-utils.ts
// Re-export is avoided here to prevent ESM module loading issues in Jest

// ── Singleton Instance ──────────────────────────────────────────────────────

let globalCache: CIDCache | null = null;

export function getGlobalCIDCache(options?: CIDCacheOptions): CIDCache {
  if (!globalCache) {
    globalCache = createCIDCache(options);
  }
  return globalCache;
}

export function resetGlobalCIDCache(): void {
  if (globalCache) {
    globalCache.close().catch(console.error);
    globalCache = null;
  }
}
