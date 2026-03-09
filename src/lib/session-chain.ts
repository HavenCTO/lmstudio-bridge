/**
 * Session Chain Module
 *
 * Implements linked session structure using IPLD for immutable session chains.
 * Each session links to the previous one, creating a verifiable history.
 *
 * @module session-chain
 */

import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import { sha256 } from "multiformats/hashes/sha2";
import * as path from "path";
import * as fs from "fs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = (() => { try { return require("better-sqlite3"); } catch { return null; } })();

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionNode {
  version: string;
  sessionId: string;
  timestamp: number;
  /** Link to previous session creates immutable chain */
  previousSession?: { "/": string };
  /** Links to conversations in this session */
  conversations: { "/": string }[];
  /** Link to encryption metadata for this session */
  encryptionMetadata?: { "/": string };
  statistics: SessionStatistics;
}

export interface SessionStatistics {
  totalRequests: number;
  totalTokens: number;
  totalSize: number;
  duration: number; // milliseconds
}

export interface SessionState {
  sessionId: string;
  sessionCid?: CID;
  startTime: number;
  conversationCids: CID[];
  encryptionMetadataCid?: CID;
  statistics: SessionStatistics;
}

export interface SessionChain {
  /** Start a new session */
  startSession(): Promise<SessionState>;
  /** Add conversation to current session */
  addConversation(conversationCid: CID): Promise<void>;
  /** Set encryption metadata CID for this session */
  setEncryptionMetadata(cid: CID): Promise<void>;
  /** Update session statistics */
  updateStatistics(stats: Partial<SessionStatistics>): Promise<void>;
  /** End session and publish to IPNS */
  endSession(): Promise<CID>;
  /** Get session history by traversing chain */
  getSessionHistory(limit?: number): Promise<SessionNode[]>;
  /** Get the current session state */
  getCurrentSession(): SessionState | null;
  /** Resume a session from persisted state */
  resumeSession(sessionId: string): Promise<SessionState | null>;
  /** Close database connection */
  close(): Promise<void>;
}

export interface SessionChainOptions {
  /** Database file path */
  dbPath?: string;
  /** IPNS manager for publishing session CIDs */
  ipnsManager?: {
    publish: (cid: CID) => Promise<unknown>;
  };
  /** Previous session CID for chaining (optional) */
  previousSessionCid?: CID;
  /** Enable WAL mode */
  enableWAL?: boolean;
}

// ── Database Schema ─────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_states (
    session_id TEXT PRIMARY KEY,
    session_cid TEXT,
    start_time INTEGER NOT NULL,
    conversation_cids TEXT NOT NULL,  -- JSON array
    encryption_metadata_cid TEXT,
    total_requests INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_size INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    ended_at INTEGER,
    active BOOLEAN DEFAULT TRUE
  );

  CREATE INDEX IF NOT EXISTS idx_active_sessions ON session_states(active);
  CREATE INDEX IF NOT EXISTS idx_session_start ON session_states(start_time);
`;

// ── Implementation ───────────────────────────────────────────────────────────

async function createBlock<T>(value: T): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagJson.encode(value);
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, hash);
  return { cid, bytes };
}

export function createSessionChain(options?: SessionChainOptions): SessionChain {
  const dbPath = options?.dbPath ?? path.resolve("./data/session-chain.db");
  const enableWAL = options?.enableWAL ?? true;
  const ipnsManager = options?.ipnsManager;

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
  const insertSessionStmt = db.prepare(
    `INSERT INTO session_states 
     (session_id, start_time, conversation_cids, active) 
     VALUES (?, ?, ?, TRUE)`
  );
  const updateSessionStmt = db.prepare(
    `UPDATE session_states SET 
     conversation_cids = ?, 
     encryption_metadata_cid = ?,
     total_requests = ?,
     total_tokens = ?,
     total_size = ?,
     duration = ?,
     session_cid = ?,
     ended_at = ?,
     active = ?
     WHERE session_id = ?`
  );
  const getActiveSessionStmt = db.prepare(
    "SELECT * FROM session_states WHERE active = TRUE ORDER BY start_time DESC LIMIT 1"
  );
  const getSessionStmt = db.prepare("SELECT * FROM session_states WHERE session_id = ?");
  const getAllSessionsStmt = db.prepare(
    "SELECT * FROM session_states ORDER BY start_time DESC LIMIT ?"
  );

  // Current session state
  let currentSession: SessionState | null = null;

  const chain: SessionChain = {
    async startSession(): Promise<SessionState> {
      // Check for any active session and end it first
      const activeRow = getActiveSessionStmt.get() as
        | {
            session_id: string;
            start_time: number;
            conversation_cids: string;
          }
        | undefined;

      if (activeRow) {
        console.log(`[session-chain] Ending previous active session: ${activeRow.session_id}`);
        await this.endSession();
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const startTime = Date.now();

      insertSessionStmt.run(sessionId, startTime, "[]");

      currentSession = {
        sessionId,
        startTime,
        conversationCids: [],
        statistics: {
          totalRequests: 0,
          totalTokens: 0,
          totalSize: 0,
          duration: 0,
        },
      };

      console.log(`[session-chain] Started new session: ${sessionId}`);

      return currentSession;
    },

    async addConversation(conversationCid: CID): Promise<void> {
      if (!currentSession) {
        throw new Error("No active session. Call startSession() first.");
      }

      currentSession.conversationCids.push(conversationCid);
      currentSession.statistics.totalRequests++;

      // Persist to database
      updateSessionStmt.run(
        JSON.stringify(currentSession.conversationCids.map((c) => c.toString())),
        currentSession.encryptionMetadataCid?.toString() ?? null,
        currentSession.statistics.totalRequests,
        currentSession.statistics.totalTokens,
        currentSession.statistics.totalSize,
        Date.now() - currentSession.startTime,
        null, // session_cid
        null, // ended_at
        true, // active
        currentSession.sessionId
      );

      console.log(
        `[session-chain] Added conversation ${conversationCid} to session ${currentSession.sessionId}`
      );
    },

    async setEncryptionMetadata(cid: CID): Promise<void> {
      if (!currentSession) {
        throw new Error("No active session. Call startSession() first.");
      }

      currentSession.encryptionMetadataCid = cid;

      updateSessionStmt.run(
        JSON.stringify(currentSession.conversationCids.map((c) => c.toString())),
        cid.toString(),
        currentSession.statistics.totalRequests,
        currentSession.statistics.totalTokens,
        currentSession.statistics.totalSize,
        Date.now() - currentSession.startTime,
        null,
        null,
        true,
        currentSession.sessionId
      );
    },

    async updateStatistics(stats: Partial<SessionStatistics>): Promise<void> {
      if (!currentSession) {
        throw new Error("No active session. Call startSession() first.");
      }

      Object.assign(currentSession.statistics, stats);
      currentSession.statistics.duration = Date.now() - currentSession.startTime;

      updateSessionStmt.run(
        JSON.stringify(currentSession.conversationCids.map((c) => c.toString())),
        currentSession.encryptionMetadataCid?.toString() ?? null,
        currentSession.statistics.totalRequests,
        currentSession.statistics.totalTokens,
        currentSession.statistics.totalSize,
        currentSession.statistics.duration,
        null,
        null,
        true,
        currentSession.sessionId
      );
    },

    async endSession(): Promise<CID> {
      if (!currentSession) {
        throw new Error("No active session. Call startSession() first.");
      }

      const duration = Date.now() - currentSession.startTime;
      currentSession.statistics.duration = duration;

      // Build session node
      const sessionNode: SessionNode = {
        version: "1.0.0",
        sessionId: currentSession.sessionId,
        timestamp: currentSession.startTime,
        conversations: currentSession.conversationCids.map((cid) => ({
          "/": cid.toString(),
        })),
        statistics: currentSession.statistics,
      };

      // Link to previous session if provided
      if (options?.previousSessionCid) {
        sessionNode.previousSession = { "/": options.previousSessionCid.toString() };
      }

      if (currentSession.encryptionMetadataCid) {
        sessionNode.encryptionMetadata = {
          "/": currentSession.encryptionMetadataCid.toString(),
        };
      }

      // Create IPLD block
      const { cid, bytes } = await createBlock(sessionNode);
      currentSession.sessionCid = cid;

      // Persist final state
      updateSessionStmt.run(
        JSON.stringify(currentSession.conversationCids.map((c) => c.toString())),
        currentSession.encryptionMetadataCid?.toString() ?? null,
        currentSession.statistics.totalRequests,
        currentSession.statistics.totalTokens,
        currentSession.statistics.totalSize,
        duration,
        cid.toString(),
        Date.now(),
        false, // active = false
        currentSession.sessionId
      );

      // Publish to IPNS if manager available
      if (ipnsManager) {
        try {
          await ipnsManager.publish(cid);
          console.log(`[session-chain] Published session to IPNS: ${cid}`);
        } catch (err) {
          console.warn(`[session-chain] Failed to publish to IPNS:`, err);
        }
      }

      console.log(
        `[session-chain] Ended session ${currentSession.sessionId}: ${cid} (${currentSession.conversationCids.length} conversations)`
      );

      const resultCid = cid;
      currentSession = null;

      return resultCid;
    },

    async getSessionHistory(limit: number = 100): Promise<SessionNode[]> {
      const rows = getAllSessionsStmt.all(limit) as Array<{
        session_cid: string | null;
        conversation_cids: string;
      }>;

      const history: SessionNode[] = [];

      for (const row of rows) {
        if (row.session_cid) {
          try {
            // In a real implementation, we would fetch from IPFS
            // For now, reconstruct from stored data
            const conversations: { "/": string }[] = JSON.parse(
              row.conversation_cids
            ).map((cid: string) => ({ "/": cid }));

            // This is a placeholder - real implementation would fetch actual node
            const node: SessionNode = {
              version: "1.0.0",
              sessionId: "", // Would be fetched
              timestamp: 0,
              conversations,
              statistics: {
                totalRequests: 0,
                totalTokens: 0,
                totalSize: 0,
                duration: 0,
              },
            };

            history.push(node);
          } catch {
            // Skip invalid entries
          }
        }
      }

      return history;
    },

    getCurrentSession(): SessionState | null {
      return currentSession;
    },

    async resumeSession(sessionId: string): Promise<SessionState | null> {
      const row = getSessionStmt.get(sessionId) as
        | {
            session_id: string;
            session_cid: string | null;
            start_time: number;
            conversation_cids: string;
            encryption_metadata_cid: string | null;
            total_requests: number;
            total_tokens: number;
            total_size: number;
            duration: number;
          }
        | undefined;

      if (!row) {
        return null;
      }

      currentSession = {
        sessionId: row.session_id,
        sessionCid: row.session_cid ? CID.parse(row.session_cid) : undefined,
        startTime: row.start_time,
        conversationCids: JSON.parse(row.conversation_cids).map((c: string) =>
          CID.parse(c)
        ),
        encryptionMetadataCid: row.encryption_metadata_cid
          ? CID.parse(row.encryption_metadata_cid)
          : undefined,
        statistics: {
          totalRequests: row.total_requests,
          totalTokens: row.total_tokens,
          totalSize: row.total_size,
          duration: row.duration,
        },
      };

      console.log(`[session-chain] Resumed session: ${sessionId}`);

      return currentSession;
    },

    async close(): Promise<void> {
      // End any active session
      if (currentSession) {
        try {
          await this.endSession();
        } catch {
          // Ignore errors during cleanup
        }
      }
      db.close();
    },
  };

  return chain;
}

// ── Singleton Instance ──────────────────────────────────────────────────────

let globalSessionChain: SessionChain | null = null;

export function getGlobalSessionChain(options?: SessionChainOptions): SessionChain {
  if (!globalSessionChain) {
    globalSessionChain = createSessionChain(options);
  }
  return globalSessionChain;
}

export function resetGlobalSessionChain(): void {
  if (globalSessionChain) {
    globalSessionChain.close().catch(console.error);
    globalSessionChain = null;
  }
}
