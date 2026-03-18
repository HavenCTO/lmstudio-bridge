/**
 * LLaVA JSONL Exporter (v2)
 *
 * Converts v2 batch archives (flat dag-cbor conversation blocks in CARv1 files)
 * to LLaVA training format JSONL files.
 *
 * No DAG traversal needed — conversations are flat blocks read via readArchive().
 *
 * Output format:
 * {"id": "<cid>", "image": "<base64>", "conversations": [{"from": "human", "value": "..."}, ...]}
 *
 * @module llava-exporter
 */

import * as fs from "fs/promises";
import * as path from "path";
import { readArchive, ArchiveConversation } from "../lib/archive-builder.js";

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

// ── LLaVA Exporter Class ────────────────────────────────────────────────────

export class LLaVAExporter {
  private options: ExportOptions;

  constructor(options: ExportOptions) {
    this.options = {
      ...options,
      extractImages: options.extractImages ?? false,
    };
  }

  /**
   * Export conversations from a v2 CAR file to JSONL format.
   * Reads the CAR → decodes flat conversation blocks → converts to LLaVA format.
   */
  async export(carPath: string): Promise<ExportResult> {
    const carBytes = await fs.readFile(carPath);
    const { conversations } = await readArchive(carBytes);

    const results: LLaVAConversation[] = [];
    const errors: ExportError[] = [];

    for (const [cidStr, conv] of conversations) {
      try {
        const result = this.convertConversation(conv, cidStr);
        if (result) results.push(result);
      } catch (error) {
        errors.push({
          conversationId: cidStr,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Ensure output directory exists
    await fs.mkdir(this.options.outputDir, { recursive: true });

    // Write JSONL file
    const jsonlPath = path.join(
      this.options.outputDir,
      `batch-${String(this.options.batchId).padStart(6, "0")}.jsonl`
    );

    const content = results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "");
    await fs.writeFile(jsonlPath, content, "utf-8");

    return {
      jsonlPath,
      conversationCount: results.length,
      totalSize: Buffer.byteLength(content, "utf-8"),
      errors,
    };
  }

  /**
   * Convert a single ArchiveConversation to LLaVA format.
   * No CID traversal needed — messages and choices are inline.
   */
  private convertConversation(
    conv: ArchiveConversation,
    cidStr: string
  ): LLaVAConversation | null {
    const turns: LLaVATurn[] = [];

    // Messages are inline — no CID traversal needed
    if (conv.request?.messages) {
      for (const msg of conv.request.messages) {
        const role: "human" | "gpt" =
          msg.role === "user" ? "human" : msg.role === "assistant" ? "gpt" : "human";

        let content: string;
        if (typeof msg.content === "string") {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Handle multi-part content (text + image_url)
          const parts: string[] = [];
          for (const part of msg.content as any[]) {
            if (part.text) {
              parts.push(part.text);
            }
            if (part.image_url?.url) {
              parts.push(`[Image: ${part.image_url.url}]`);
            }
          }
          content = parts.join("\n");
        } else {
          content = JSON.stringify(msg.content);
        }

        turns.push({ from: role, value: content });
      }
    }

    // Response choices are inline too
    if (conv.response?.choices) {
      for (const choice of conv.response.choices) {
        turns.push({ from: "gpt", value: choice.message.content });
      }
    }

    // Extract image if enabled
    let image = "";
    if (this.options.extractImages && this.options.imagePattern) {
      image = this.extractImageSync(turns);
    }

    return { id: conv.id || cidStr, image, conversations: turns };
  }

  /**
   * Extract image from conversations (synchronous version)
   */
  private extractImageSync(conversations: LLaVATurn[]): string {
    if (!this.options.imagePattern) {
      return "";
    }

    const { urlPattern } = this.options.imagePattern;

    for (const turn of conversations) {
      const match = urlPattern.exec(turn.value);
      if (match && match[0]) {
        // Return the URL as a placeholder — actual fetching would be async
        return match[0];
      }
    }

    return "";
  }
}

// ── Factory Function ────────────────────────────────────────────────────────

export function createLLaVAExporter(options: ExportOptions): LLaVAExporter {
  return new LLaVAExporter(options);
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Export a batch of conversations from a CAR file to JSONL.
 * Simplified v2 version — reads flat blocks, no DAG traversal.
 */
export async function exportBatchFromCAR(
  carPath: string,
  outputDir: string,
  batchId: number
): Promise<ExportResult> {
  const exporter = createLLaVAExporter({ outputDir, batchId });
  return exporter.export(carPath);
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
