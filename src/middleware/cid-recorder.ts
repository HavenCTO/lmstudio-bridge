/**
 * CID Recorder middleware.
 *
 * Persists IPFS/Filecoin CIDs to disk in a normalized Parquet layout:
 *
 *   `<dir>/sessions.parquet` — one row per shim session
 *     | id (INT32) | metadataCid (UTF8) |
 *
 *   `<dir>/<id>.parquet` — one file per session, rows are just CIDs
 *     | cid (UTF8) |
 *
 * The `id` is an auto-incrementing integer derived from the existing
 * sessions file.  The metadataCid is stored once per session (not per
 * CID), so millions of uploads only cost 1 metadataCid string total.
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

const CIDS_SCHEMA = new ParquetSchema({
  cid: { type: "UTF8" },
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

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SessionRow {
  id: number;
  metadataCid: string;
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

  // Open per-session CIDs file
  const cidsFile = path.join(outputDir, `${sessionId}.parquet`);
  const writer = await ParquetWriter.openFile(CIDS_SCHEMA, cidsFile);

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
      const cid = payload.context.metadata.uploadCid;
      if (cid) {
        try {
          await writer.appendRow({ cid });
          console.log(
            `[cid-recorder] ${payload.context.requestId} | recorded CID=${cid}`
          );
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
      console.log(`[cid-recorder] parquet file closed → ${cidsFile}`);
    } catch (err) {
      console.error(`[cid-recorder] error closing parquet file:`, err);
    }
  };

  return { middleware, sessionId, close };
}