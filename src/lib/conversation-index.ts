/**
 * Conversation Index Module
 *
 * Implements a searchable, paginated index of conversations using IPLD.
 * Published to IPNS for discoverability.
 *
 * @module conversation-index
 */

import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import { sha256 } from "multiformats/hashes/sha2";
import * as path from "path";
import * as fs from "fs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = (() => { try { return require("better-sqlite3"); } catch { return null; } })();

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexEntry {
  conversationCid: { "/": string };
  timestamp: number;
  model: string;
  firstUserMessage: string;
  tokenCount: number;
}

export interface IndexNode {
  entries: IndexEntry[];
  nextPage?: { "/": string };
}

export interface ConversationIndex {
  root: { "/": string };
  version: string;
}

export interface QueryFilters {
  model?: string;
  startTime?: number;
  endTime?: number;
  minTokens?: number;
  maxTokens?: number;
  searchText?: string;
}

export interface QueryResult {
  entries: IndexEntry[];
  totalCount: number;
  hasMore: boolean;
  nextPageCid?: CID;
}

export interface ConversationIndexer {
  /** Add conversation to index */
  indexConversation(
    rootCid: CID,
    metadata: {
      timestamp: number;
      model: string;
      firstUserMessage: string;
      tokenCount: number;
    }
  ): Promise<void>;
  /** Query conversations with filters */
  query(filters: QueryFilters, pageSize?: number): Promise<QueryResult>;
  /** Rebuild index from scratch */
  rebuild(): Promise<CID>;
  /** Get current index root CID */
  getIndexRoot(): CID | null;
  /** Publish index to IPNS */
  publishToIPNS(publishFn: (cid: CID) => Promise<void>): Promise<void>;
  /** Close database connection */
  close(): Promise<void>;
}

export interface ConversationIndexerOptions {
  /** Database file path */
  dbPath?: string;
  /** Maximum entries per index page */
  entriesPerPage?: number;
  /** Shim ID for IPNS publishing */
  shimId?: string;
  /** Enable WAL mode */
  enableWAL?: boolean;
}

// ── Database Schema ─────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversation_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_cid TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL,
    model TEXT,
    first_user_message TEXT,
    token_count INTEGER DEFAULT 0,
    indexed_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_timestamp ON conversation_index(timestamp);
  CREATE INDEX IF NOT EXISTS idx_model ON conversation_index(model);
  CREATE INDEX IF NOT EXISTS idx_tokens ON conversation_index(token_count);
  CREATE INDEX IF NOT EXISTS idx_message ON conversation_index(first_user_message);
`;

// ── Implementation ───────────────────────────────────────────────────────────

async function createBlock<T>(value: T): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagJson.encode(value);
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, hash);
  return { cid, bytes };
}

export function createConversationIndexer(options?: ConversationIndexerOptions): ConversationIndexer {
  const dbPath = options?.dbPath ?? path.resolve("./data/conversation-index.db");
  const entriesPerPage = options?.entriesPerPage ?? 100;
  const shimId = options?.shimId ?? "default";
  const enableWAL = options?.enableWAL ?? true;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open database (fallback to in-memory if not available)
  const db = Database ? new Database(dbPath) : null;
  
  if (!db) {
    // Return a minimal in-memory indexer
    let currentRootCid: CID | null = null;
    const entries: IndexEntry[] = [];
    
    return {
      async indexConversation(rootCid: CID, metadata: { timestamp: number; model: string; firstUserMessage: string; tokenCount: number }): Promise<void> {
        entries.push({
          conversationCid: { "/": rootCid.toString() },
          timestamp: metadata.timestamp,
          model: metadata.model,
          firstUserMessage: metadata.firstUserMessage,
          tokenCount: metadata.tokenCount,
        });
      },
      async query(filters: QueryFilters, pageSize = 50): Promise<QueryResult> {
        let result = entries;
        if (filters.model) result = result.filter(e => e.model === filters.model);
        if (filters.startTime) result = result.filter(e => e.timestamp >= filters.startTime!);
        if (filters.endTime) result = result.filter(e => e.timestamp <= filters.endTime!);
        if (filters.searchText) result = result.filter(e => e.firstUserMessage.includes(filters.searchText!));
        return { entries: result.slice(0, pageSize), totalCount: result.length, hasMore: result.length > pageSize };
      },
      async rebuild(): Promise<CID> {
        const node: IndexNode = { entries };
        const bytes = dagJson.encode(node);
        const hash = await sha256.digest(bytes);
        currentRootCid = CID.create(1, dagJson.code, hash);
        return currentRootCid;
      },
      getIndexRoot(): CID | null { return currentRootCid; },
      async publishToIPNS(publishFn: (cid: CID) => Promise<void>): Promise<void> {
        if (currentRootCid) await publishFn(currentRootCid);
      },
      async close(): Promise<void> { /* no-op */ },
    };
  }

  if (enableWAL) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }

  // Initialize schema
  db.exec(SCHEMA);

  // Prepare statements
  const insertEntryStmt = db.prepare(
    `INSERT OR REPLACE INTO conversation_index 
     (conversation_cid, timestamp, model, first_user_message, token_count, indexed_at) 
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const queryStmt = db.prepare(
    `SELECT * FROM conversation_index 
     WHERE (?1 IS NULL OR model = ?1)
     AND (?2 IS NULL OR timestamp >= ?2)
     AND (?3 IS NULL OR timestamp <= ?3)
     AND (?4 IS NULL OR token_count >= ?4)
     AND (?5 IS NULL OR token_count <= ?5)
     AND (?6 IS NULL OR first_user_message LIKE ?6)
     ORDER BY timestamp DESC
     LIMIT ?7 OFFSET ?8`
  );
  const countStmt = db.prepare(
    `SELECT COUNT(*) as count FROM conversation_index 
     WHERE (?1 IS NULL OR model = ?1)
     AND (?2 IS NULL OR timestamp >= ?2)
     AND (?3 IS NULL OR timestamp <= ?3)
     AND (?4 IS NULL OR token_count >= ?4)
     AND (?5 IS NULL OR token_count <= ?5)
     AND (?6 IS NULL OR first_user_message LIKE ?6)`
  );
  const getAllStmt = db.prepare(
    "SELECT * FROM conversation_index ORDER BY timestamp DESC"
  );
  const clearStmt = db.prepare("DELETE FROM conversation_index");

  // Current index state
  let currentRootCid: CID | null = null;

  const indexer: ConversationIndexer = {
    async indexConversation(
      rootCid: CID,
      metadata: {
        timestamp: number;
        model: string;
        firstUserMessage: string;
        tokenCount: number;
      }
    ): Promise<void> {
      insertEntryStmt.run(
        rootCid.toString(),
        metadata.timestamp,
        metadata.model,
        metadata.firstUserMessage.substring(0, 500), // Limit storage
        metadata.tokenCount,
        Date.now()
      );

      console.log(`[conversation-index] Indexed ${rootCid} (${metadata.model})`);
    },

    async query(filters: QueryFilters, pageSize: number = 50): Promise<QueryResult> {
      const searchPattern = filters.searchText ? `%${filters.searchText}%` : null;

      // Get total count
      const countResult = countStmt.get(
        filters.model ?? null,
        filters.startTime ?? null,
        filters.endTime ?? null,
        filters.minTokens ?? null,
        filters.maxTokens ?? null,
        searchPattern
      ) as { count: number };

      // Get entries
      const rows = queryStmt.all(
        filters.model ?? null,
        filters.startTime ?? null,
        filters.endTime ?? null,
        filters.minTokens ?? null,
        filters.maxTokens ?? null,
        searchPattern,
        pageSize,
        0
      ) as Array<{
        conversation_cid: string;
        timestamp: number;
        model: string;
        first_user_message: string;
        token_count: number;
      }>;

      const entries: IndexEntry[] = rows.map((row) => ({
        conversationCid: { "/": row.conversation_cid },
        timestamp: row.timestamp,
        model: row.model,
        firstUserMessage: row.first_user_message,
        tokenCount: row.token_count,
      }));

      return {
        entries,
        totalCount: countResult.count,
        hasMore: countResult.count > pageSize,
      };
    },

    async rebuild(): Promise<CID> {
      console.log("[conversation-index] Rebuilding index...");

      // Get all conversations
      const rows = getAllStmt.all() as Array<{
        conversation_cid: string;
        timestamp: number;
        model: string;
        first_user_message: string;
        token_count: number;
      }>;

      // Build index pages
      const pages: { cid: CID; node: IndexNode }[] = [];

      for (let i = 0; i < rows.length; i += entriesPerPage) {
        const pageRows = rows.slice(i, i + entriesPerPage);

        const entries: IndexEntry[] = pageRows.map((row) => ({
          conversationCid: { "/": row.conversation_cid },
          timestamp: row.timestamp,
          model: row.model,
          firstUserMessage: row.first_user_message,
          tokenCount: row.token_count,
        }));

        // Link to next page (built in reverse)
        const node: IndexNode = { entries };
        if (pages.length > 0) {
          node.nextPage = { "/": pages[pages.length - 1].cid.toString() };
        }

        const { cid } = await createBlock(node);
        pages.push({ cid, node });
      }

      if (pages.length === 0) {
        // Empty index
        const emptyNode: IndexNode = { entries: [] };
        const { cid } = await createBlock(emptyNode);
        currentRootCid = cid;
        return cid;
      }

      // Root is the last page built (most recent)
      currentRootCid = pages[pages.length - 1].cid;

      console.log(
        `[conversation-index] Rebuilt index: ${currentRootCid} (${pages.length} pages, ${rows.length} entries)`
      );

      return currentRootCid;
    },

    getIndexRoot(): CID | null {
      return currentRootCid;
    },

    async publishToIPNS(
      publishFn: (cid: CID) => Promise<void>
    ): Promise<void> {
      if (!currentRootCid) {
        await this.rebuild();
      }

      if (currentRootCid) {
        await publishFn(currentRootCid);
        console.log(`[conversation-index] Published to IPNS: ${currentRootCid}`);
      }
    },

    async close(): Promise<void> {
      db.close();
    },
  };

  return indexer;
}

// ── Helper Functions ────────────────────────────────────────────────────────

/**
 * Extract searchable text from conversation request
 */
export function extractSearchableText(
  request: { messages?: Array<{ role: string; content: unknown }> }
): string {
  if (!request.messages) return "";

  const userMessages = request.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return "";

  const firstMessage = userMessages[0];
  if (typeof firstMessage.content === "string") {
    return firstMessage.content.substring(0, 200);
  }

  return "";
}

/**
 * Calculate total token count from usage data
 */
export function calculateTokenCount(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
): number {
  if (!usage) return 0;
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

/**
 * Create a search filter from query string
 */
export function parseSearchQuery(query: string): QueryFilters {
  const filters: QueryFilters = {};

  // Parse model filter
  const modelMatch = query.match(/model:(\S+)/);
  if (modelMatch) {
    filters.model = modelMatch[1];
    query = query.replace(modelMatch[0], "").trim();
  }

  // Parse time range
  const afterMatch = query.match(/after:(\d+)/);
  if (afterMatch) {
    filters.startTime = parseInt(afterMatch[1], 10);
    query = query.replace(afterMatch[0], "").trim();
  }

  const beforeMatch = query.match(/before:((\d+))/);
  if (beforeMatch) {
    filters.endTime = parseInt(beforeMatch[1], 10);
    query = query.replace(beforeMatch[0], "").trim();
  }

  // Remaining text is search
  if (query.trim()) {
    filters.searchText = query.trim();
  }

  return filters;
}

// ── Singleton Instance ──────────────────────────────────────────────────────

let globalConversationIndexer: ConversationIndexer | null = null;

export function getGlobalConversationIndexer(
  options?: ConversationIndexerOptions
): ConversationIndexer {
  if (!globalConversationIndexer) {
    globalConversationIndexer = createConversationIndexer(options);
  }
  return globalConversationIndexer;
}

export function resetGlobalConversationIndexer(): void {
  if (globalConversationIndexer) {
    globalConversationIndexer.close().catch(console.error);
    globalConversationIndexer = null;
  }
}
