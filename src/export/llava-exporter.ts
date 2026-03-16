/**
 * LLaVA JSONL Exporter
 *
 * Converts IPLD conversation DAGs to LLaVA training format JSONL files.
 * Supports batch processing with per-batch JSONL output for crash recovery.
 *
 * Output format:
 * {"id": "<cid>", "image": "<base64>", "conversations": [{"from": "human", "value": "..."}, ...]}
 *
 * @module llava-exporter
 */

import * as fs from "fs/promises";
import * as path from "path";
import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LLaVAConversation {
  id: string;
  image: string;
  conversations: LLaVATurn[];
}

export interface LLaVATurn {
  from: "human" | "gpt";
  value: string;
}

export interface ExportOptions {
  /** Output directory for JSONL files */
  outputDir: string;
  /** Batch ID for filename */
  batchId: number;
  /** Extract images from message blocks (default: false) */
  extractImages?: boolean;
  /** Image extraction pattern */
  imagePattern?: ImagePattern;
}

export interface ImagePattern {
  /** Regex pattern to match image URLs in content */
  urlPattern: RegExp;
  /** Function to fetch image data given URL */
  fetchImage: (url: string) => Promise<Uint8Array | null>;
  /** Convert image to base64 */
  toBase64?: (data: Uint8Array) => string;
}

export interface ExportResult {
  /** Path to generated JSONL file */
  jsonlPath: string;
  /** Number of conversations exported */
  conversationCount: number;
  /** Total size in bytes */
  totalSize: number;
  /** Any errors encountered */
  errors: ExportError[];
}

export interface ExportError {
  conversationId: string;
  error: string;
}

// ── IPLD Types (matching ipld-builder.ts) ───────────────────────────────────

interface IPLDMessage {
  role: string;
  content: string | IPLDContentPart[];
}

interface IPLDContentPart {
  type: string;
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

interface IPLDRequest {
  model: string;
  messages: CID[];
  parameters?: Record<string, unknown>;
}

interface IPLDChoice {
  index: number;
  message: CID;
  finish_reason: string;
}

interface IPLDResponse {
  id: string;
  model: string;
  choices: CID[];
  created: number;
}

interface IPLDConversation {
  version: string;
  request: CID;
  response: CID;
  metadata: CID;
  timestamp: number;
}

// ── Block Store Interface ───────────────────────────────────────────────────

export interface BlockStore {
  /** Get block bytes by CID string */
  get(cid: string): Promise<Uint8Array | null>;
}

// ── LLaVA Exporter Class ────────────────────────────────────────────────────

export class LLaVAExporter {
  private blockStore: BlockStore;
  private options: ExportOptions;

  constructor(blockStore: BlockStore, options: ExportOptions) {
    this.blockStore = blockStore;
    this.options = {
      ...options,
      extractImages: options.extractImages ?? false,
    };
  }

  /**
   * Export a batch of conversation CIDs to JSONL format
   */
  async export(conversationCids: string[]): Promise<ExportResult> {
    const errors: ExportError[] = [];
    const results: LLaVAConversation[] = [];
    let totalSize = 0;

    // Ensure output directory exists
    await fs.mkdir(this.options.outputDir, { recursive: true });

    for (const cidStr of conversationCids) {
      try {
        const conversation = await this.convertConversation(cidStr);
        if (conversation) {
          results.push(conversation);
          totalSize += JSON.stringify(conversation).length + 1; // +1 for newline
        }
      } catch (error) {
        errors.push({
          conversationId: cidStr,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Write JSONL file
    const jsonlPath = path.join(
      this.options.outputDir,
      `batch-${String(this.options.batchId).padStart(6, "0")}.jsonl`
    );

    const lines = results.map((conv) => JSON.stringify(conv)).join("\n");
    const content = lines ? lines + "\n" : "";
    await fs.writeFile(jsonlPath, content, "utf-8");

    return {
      jsonlPath,
      conversationCount: results.length,
      totalSize: Buffer.byteLength(content, "utf-8"),
      errors,
    };
  }

  /**
   * Convert a single conversation CID to LLaVA format
   */
  private async convertConversation(
    rootCidStr: string
  ): Promise<LLaVAConversation | null> {
    // Load conversation root
    const rootBytes = await this.blockStore.get(rootCidStr);
    if (!rootBytes) {
      throw new Error(`Conversation block not found: ${rootCidStr}`);
    }

    const root = dagJson.decode<IPLDConversation>(rootBytes);

    // Load request
    const requestBytes = await this.blockStore.get(root.request.toString());
    if (!requestBytes) {
      throw new Error(`Request block not found: ${root.request}`);
    }

    const request = dagJson.decode<IPLDRequest>(requestBytes);

    // Load response
    const responseBytes = await this.blockStore.get(root.response.toString());
    if (!responseBytes) {
      throw new Error(`Response block not found: ${root.response}`);
    }

    const response = dagJson.decode<IPLDResponse>(responseBytes);

    // Build conversations array from messages
    const conversations: LLaVATurn[] = [];

    // Process request messages (human turns)
    for (const msgCid of request.messages) {
      const msgBytes = await this.blockStore.get(msgCid.toString());
      if (!msgBytes) continue;

      const msg = dagJson.decode<IPLDMessage>(msgBytes);
      const turn = this.convertMessage(msg, "human");
      if (turn) {
        conversations.push(turn);
      }
    }

    // Process response choices (gpt turns)
    for (const choiceCid of response.choices) {
      const choiceBytes = await this.blockStore.get(choiceCid.toString());
      if (!choiceBytes) continue;

      const choice = dagJson.decode<{ message: CID }>(choiceBytes);
      const msgBytes = await this.blockStore.get(choice.message.toString());
      if (!msgBytes) continue;

      const msg = dagJson.decode<IPLDMessage>(msgBytes);
      const turn = this.convertMessage(msg, "gpt");
      if (turn) {
        conversations.push(turn);
      }
    }

    // Extract image if enabled
    let image = "";
    if (this.options.extractImages && this.options.imagePattern) {
      image = await this.extractImage(conversations);
    }

    return {
      id: rootCidStr,
      image,
      conversations,
    };
  }

  /**
   * Convert IPLD message to LLaVA turn
   */
  private convertMessage(
    msg: IPLDMessage,
    defaultRole: "human" | "gpt"
  ): LLaVATurn | null {
    const role = msg.role === "user" ? "human" : msg.role === "assistant" ? "gpt" : defaultRole;

    if (typeof msg.content === "string") {
      return {
        from: role,
        value: msg.content,
      };
    }

    if (Array.isArray(msg.content)) {
      // Handle multi-part content
      const parts: string[] = [];
      for (const part of msg.content) {
        if (part.text) {
          parts.push(part.text);
        }
        if (part.image_url?.url) {
          // Include image URL as text reference
          parts.push(`[Image: ${part.image_url.url}]`);
        }
      }
      if (parts.length > 0) {
        return {
          from: role,
          value: parts.join("\n"),
        };
      }
    }

    return null;
  }

  /**
   * Extract image from conversations
   */
  private async extractImage(conversations: LLaVATurn[]): Promise<string> {
    if (!this.options.imagePattern) {
      return "";
    }

    const { urlPattern, fetchImage, toBase64 } = this.options.imagePattern;

    for (const turn of conversations) {
      const match = urlPattern.exec(turn.value);
      if (match && match[0]) {
        const imageData = await fetchImage(match[0]);
        if (imageData) {
          if (toBase64) {
            return toBase64(imageData);
          }
          // Default: convert Uint8Array to base64
          return Buffer.from(imageData).toString("base64");
        }
      }
    }

    return "";
  }
}

// ── Factory Function ────────────────────────────────────────────────────────

export function createLLaVAExporter(
  blockStore: BlockStore,
  options: ExportOptions
): LLaVAExporter {
  return new LLaVAExporter(blockStore, options);
}

// ── Simple In-Memory Block Store (for testing) ─────────────────────────────

export class InMemoryBlockStore implements BlockStore {
  private blocks: Map<string, Uint8Array>;

  constructor(blocks?: Map<string, Uint8Array>) {
    this.blocks = blocks ?? new Map();
  }

  async get(cid: string): Promise<Uint8Array | null> {
    return this.blocks.get(cid) ?? null;
  }

  set(cid: string, bytes: Uint8Array): void {
    this.blocks.set(cid, bytes);
  }

  clear(): void {
    this.blocks.clear();
  }
}

// ── File-based Block Store (for CAR extraction) ────────────────────────────

export interface FileBlockStoreOptions {
  carPath: string;
}

export class FileBlockStore implements BlockStore {
  private carPath: string;
  private blocks: Map<string, Uint8Array> | null = null;

  constructor(options: FileBlockStoreOptions) {
    this.carPath = options.carPath;
  }

  /**
   * Parse CAR file and extract all blocks
   */
  private async loadCAR(): Promise<Map<string, Uint8Array>> {
    if (this.blocks) {
      return this.blocks;
    }

    const { decode: cborDecode } = await import("cborg");

    const carBytes = await fs.readFile(this.carPath);
    const blocks = new Map<string, Uint8Array>();

    let offset = 0;

    // Read header length varint
    const headerLength = this.readVarint(carBytes, offset);
    offset += headerLength.bytesRead;

    // Parse header (CBOR array of root CIDs)
    const header = cborDecode(carBytes.subarray(offset, offset + headerLength.value));
    offset += headerLength.value;

    // Read blocks
    while (offset < carBytes.length) {
      // Read CID length varint
      const cidLength = this.readVarint(carBytes, offset);
      offset += cidLength.bytesRead;

      // Parse CID
      const cidBytes = carBytes.subarray(offset, offset + cidLength.value);
      const cid = cborDecode(cidBytes);
      const cidStr = cid.toString();
      offset += cidLength.value;

      // Read block length varint
      const blockLength = this.readVarint(carBytes, offset);
      offset += blockLength.bytesRead;

      // Read block bytes
      const blockBytes = carBytes.subarray(offset, offset + blockLength.value);
      blocks.set(cidStr, blockBytes);
      offset += blockLength.value;
    }

    this.blocks = blocks;
    return blocks;
  }

  /**
   * Read varint from bytes
   */
  private readVarint(
    bytes: Uint8Array,
    offset: number
  ): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset + bytesRead < bytes.length) {
      const byte = bytes[offset + bytesRead];
      value |= (byte & 0x7f) << shift;
      bytesRead++;

      if ((byte & 0x80) === 0) {
        break;
      }

      shift += 7;
    }

    return { value, bytesRead };
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const blocks = await this.loadCAR();
    return blocks.get(cid) ?? null;
  }
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Export a batch of conversations from a CAR file to JSONL
 */
export async function exportBatchFromCAR(
  carPath: string,
  conversationCids: string[],
  outputDir: string,
  batchId: number
): Promise<ExportResult> {
  const blockStore = new FileBlockStore({ carPath });
  const exporter = createLLaVAExporter(blockStore, {
    outputDir,
    batchId,
  });

  return exporter.export(conversationCids);
}

/**
 * Convert base64 image to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64
 */
export function uint8ArrayToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}