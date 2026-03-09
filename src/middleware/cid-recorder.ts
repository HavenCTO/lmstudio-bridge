/**
 * CID Recorder middleware.
 *
 * Persists IPFS/Filecoin CIDs to disk in a normalized Parquet layout:
 *
 *   `<dir>/sessions.parquet` — one row per shim session
 *     | id (INT32) | metadataCid (UTF8) |
 *
 *   `<dir>/<id>.parquet` — one file per session, rows are conversation records
 *     | cid (UTF8) | rootCid (UTF8) | requestCid (UTF8) | responseCid (UTF8) |
 *     | messageCids (UTF8 - JSON array) | timestamp (INT64) |
 *     | linkedFrom (UTF8) | systemPromptCids (UTF8 - JSON array) |
 *
 * The `id` is an auto-incrementing integer derived from the existing
 * sessions file.  The metadataCid is stored once per session (not per
 * CID), so millions of uploads only cost 1 metadataCid string total.
 *
 * For IPLD-native conversations, tracks component CIDs:
 *   - Root conversation CID
 *   - Request CID
 *   - Response CID
 *   - Individual message CIDs
 *   - System prompt CIDs (if deduplicated)
 *   - Link to previous conversation (for chain traversal)
 *
 * Default directory: `./cids/`  Override with `--cid-log <dir>`.
 */

import * as fs from "fs";
import * as path from "path";
import { ParquetSchema, ParquetWriter, ParquetReader } from "parquetjs-lite";
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from "../types";

// ── Schemas ─────────────────────────────────────────────────────────────────

const SESSIONS_SCHEMA = new ParquetSchema({
  id: { type: "INT32" },
  metadataCid: { type: "UTF8" },
});

// Enhanced schema for IPLD component tracking
const CONVERSATION_SCHEMA = new ParquetSchema({
  cid: { type: "UTF8" },           // Legacy: main upload CID
  rootCid: { type: "UTF8" },       // IPLD: root conversation CID
  requestCid: { type: "UTF8" },    // IPLD: request node CID
  responseCid: { type: "UTF8" },   // IPLD: response node CID
  messageCids: { type: "UTF8" },   // JSON array of message CIDs
  timestamp: { type: "INT64" },
  linkedFrom: { type: "UTF8" },    // Previous conversation CID
  systemPromptCids: { type: "UTF8" }, // JSON array of deduplicated prompt CIDs
});

// ── Public types ────────────────────────────────────────────────────────────

export interface CidRecorderOptions {
  /**
   * Directory for the Parquet files.
   * Defaults to `./cids`.
   */
  outputDir?: string;

  /**
   * Session-level encryption metadata CID (IPFS).
   * Empty string when encryption is not active.
   */
  sessionMetadataCid?: string;
}

export interface CidRecorderHandle {
  /** The middleware to register with the engine. */
  middleware: Middleware;
  /** The auto-assigned session ID for this run. */
  sessionId: number;
  /** Flush and close the Parquet file.  Call on graceful shutdown. */
  close: () => Promise<void>;
}

/**
 * IPLD Component CID Record
 * Tracks all CIDs that make up a conversation for granular retrieval
 */
export interface ConversationCIDRecord {
  /** Root CID of the conversation DAG */
  rootCid: string;
  /** Timestamp when recorded */
  timestamp: number;
  components: {
    /** CID of the request node */
    request: string;
    /** CID of the response node */
    response: string;
    /** CIDs of individual message nodes */
    messages: string[];
    /** CIDs of deduplicated system prompts */
    systemPrompts: string[];
  };
  /** CID of previous conversation in chain (if any) */
  linkedFrom?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SessionRow {
  id: number;
  metadataCid: string;
}

interface ConversationRow {
  cid: string;
  rootCid: string;
  requestCid: string;
  responseCid: string;
  messageCids: string;
  timestamp: number;
  linkedFrom: string;
  systemPromptCids: string;
}

/**
 * Read existing sessions from the Parquet file.
 * Returns an empty array if the file doesn't exist.
 */
async function readSessions(filePath: string): Promise<SessionRow[]> {
  if (!fs.existsSync(filePath)) return [];
  try {
    const reader = await ParquetReader.openFile(filePath);
    const cursor = (reader as any).getCursor();
    const rows: SessionRow[] = [];
    let row: any;
    while ((row = await cursor.next())) {
      rows.push({ id: Number(row.id), metadataCid: String(row.metadataCid) });
    }
    await reader.close();
    return rows;
  } catch {
    return [];
  }
}

/**
 * Write the full sessions array to Parquet (overwrites).
 */
async function writeSessions(
  filePath: string,
  sessions: SessionRow[]
): Promise<void> {
  const writer = await ParquetWriter.openFile(SESSIONS_SCHEMA, filePath);
  for (const s of sessions) {
    await writer.appendRow({ id: s.id, metadataCid: s.metadataCid });
  }
  await writer.close();
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the CID recorder with a normalized two-table Parquet layout.
 *
 * ```ts
 * const recorder = await createCidRecorder({ sessionMetadataCid });
 * engine.use(recorder.middleware);
 * // on shutdown…
 * await recorder.close();
 * ```
 */
export async function createCidRecorder(
  options?: CidRecorderOptions
): Promise<CidRecorderHandle> {
  const outputDir = path.resolve(options?.outputDir ?? "cids");
  const metadataCid = options?.sessionMetadataCid ?? "";

  // Ensure directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const sessionsFile = path.join(outputDir, "sessions.parquet");

  // Read existing sessions → derive next ID
  const sessions = await readSessions(sessionsFile);
  const sessionId =
    sessions.length > 0
      ? Math.max(...sessions.map((s) => s.id)) + 1
      : 0;

  // Append new session and rewrite
  sessions.push({ id: sessionId, metadataCid });
  await writeSessions(sessionsFile, sessions);
  console.log(
    `[cid-recorder] session ${sessionId} registered` +
      (metadataCid ? ` (metadataCid=${metadataCid})` : "")
  );

  // Open per-session conversations file
  const conversationsFile = path.join(outputDir, `${sessionId}.parquet`);
  const writer = await ParquetWriter.openFile(CONVERSATION_SCHEMA, conversationsFile);

  const middleware: Middleware = {
    name: "cid-recorder",

    async onRequest(
      _payload: RequestPayload,
      next: NextFunction
    ): Promise<void> {
      await next();
    },

    async onResponse(
      payload: ResponsePayload,
      next: NextFunction
    ): Promise<void> {
      const uploadCid = payload.context.metadata.uploadCid as string | undefined;
      
      if (uploadCid) {
        try {
          // Build conversation record
          const record: ConversationRow = {
            cid: uploadCid,
            rootCid: (payload.context.metadata.rootCid as string) ?? uploadCid,
            requestCid: (payload.context.metadata.requestCid as string) ?? "",
            responseCid: (payload.context.metadata.responseCid as string) ?? "",
            messageCids: JSON.stringify(payload.context.metadata.messageCids ?? []),
            timestamp: Date.now(),
            linkedFrom: (payload.context.metadata.linkedFrom as string) ?? "",
            systemPromptCids: JSON.stringify(payload.context.metadata.systemPromptCids ?? []),
          };

          await writer.appendRow(record as unknown as Record<string, unknown>);

          // Log with component details if available
          const components = payload.context.metadata.messageCids as string[] | undefined;
          const componentInfo = components 
            ? ` (components: ${components.length} messages)` 
            : "";
          
          console.log(
            `[cid-recorder] ${payload.context.requestId} | recorded CID=${uploadCid}${componentInfo}`
          );

          // Log deduplication stats if available
          if (payload.context.metadata.systemPromptCids) {
            const promptCids = payload.context.metadata.systemPromptCids as string[];
            if (promptCids.length > 0) {
              console.log(
                `[cid-recorder] ${payload.context.requestId} | deduplicated ${promptCids.length} system prompt(s)`
              );
            }
          }
        } catch (err) {
          console.error(
            `[cid-recorder] ${payload.context.requestId} | failed to write:`,
            err
          );
        }
      }

      await next();
    },
  };

  const close = async (): Promise<void> => {
    try {
      await writer.close();
      console.log(`[cid-recorder] parquet file closed → ${conversationsFile}`);
    } catch (err) {
      console.error(`[cid-recorder] error closing parquet file:`, err);
    }
  };

  return { middleware, sessionId, close };
}

// ── Helper Functions for Component Tracking ─────────────────────────────────

/**
 * Build a conversation record from IPLD components
 */
export function buildConversationRecord(
  rootCid: string,
  components: {
    request: string;
    response: string;
    messages: string[];
    systemPrompts?: string[];
  },
  linkedFrom?: string
): ConversationCIDRecord {
  return {
    rootCid,
    timestamp: Date.now(),
    components: {
      request: components.request,
      response: components.response,
      messages: components.messages,
      systemPrompts: components.systemPrompts ?? [],
    },
    linkedFrom,
  };
}

/**
 * Serialize component CIDs for storage
 */
export function serializeComponents(
  record: ConversationCIDRecord
): Record<string, string | number> {
  return {
    cid: record.rootCid,
    rootCid: record.rootCid,
    requestCid: record.components.request,
    responseCid: record.components.response,
    messageCids: JSON.stringify(record.components.messages),
    timestamp: record.timestamp,
    linkedFrom: record.linkedFrom ?? "",
    systemPromptCids: JSON.stringify(record.components.systemPrompts),
  };
}

/**
 * Read conversation records from a session file
 */
export async function readConversations(
  filePath: string
): Promise<ConversationCIDRecord[]> {
  if (!fs.existsSync(filePath)) return [];

  try {
    const reader = await ParquetReader.openFile(filePath);
    const cursor = (reader as any).getCursor();
    const records: ConversationCIDRecord[] = [];

    let row: any;
    while ((row = await cursor.next())) {
      try {
        const record: ConversationCIDRecord = {
          rootCid: String(row.rootCid || row.cid),
          timestamp: Number(row.timestamp),
          components: {
            request: String(row.requestCid || ""),
            response: String(row.responseCid || ""),
            messages: JSON.parse(String(row.messageCids || "[]")),
            systemPrompts: JSON.parse(String(row.systemPromptCids || "[]")),
          },
        };

        if (row.linkedFrom) {
          record.linkedFrom = String(row.linkedFrom);
        }

        records.push(record);
      } catch (parseErr) {
        console.warn(`[cid-recorder] Failed to parse row:`, parseErr);
      }
    }

    await reader.close();
    return records;
  } catch (err) {
    console.error(`[cid-recorder] Failed to read conversations:`, err);
    return [];
  }
}

/**
 * Find all conversations that link to a given CID
 */
export async function findLinkedConversations(
  sessionFilePath: string,
  targetCid: string
): Promise<ConversationCIDRecord[]> {
  const allConversations = await readConversations(sessionFilePath);
  return allConversations.filter(
    (conv) => conv.linkedFrom === targetCid
  );
}

/**
 * Get conversation chain starting from a root CID
 */
export async function getConversationChain(
  sessionFilePath: string,
  startCid: string,
  maxDepth: number = 100
): Promise<ConversationCIDRecord[]> {
  const chain: ConversationCIDRecord[] = [];
  const allConversations = await readConversations(sessionFilePath);
  const conversationMap = new Map(allConversations.map(c => [c.rootCid, c]));

  let currentCid: string | undefined = startCid;
  let depth = 0;

  while (currentCid && depth < maxDepth) {
    const conv = conversationMap.get(currentCid);
    if (!conv) break;

    chain.push(conv);
    currentCid = conv.linkedFrom;
    depth++;
  }

  return chain;
}
