/**
 * IPLD Builder Module
 *
 * Constructs IPLD DAGs from conversation data using dag-json codec.
 * Provides granular content addressing for deduplication and efficient retrieval.
 *
 * @module ipld-builder
 */

import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import { sha256 } from "multiformats/hashes/sha2";
import { Block } from "multiformats/block";
import {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatMessage,
} from "../types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Previous conversation CID for chain linking */
  previousConversation?: CID;
  /** Skip deduplication (store all content as new nodes) */
  skipDeduplication?: boolean;
  /** System prompt cache for deduplication */
  promptCache?: PromptCache;
}

export interface ConversationRoot {
  rootCid: CID;
  messageCids: CID[];
  requestCid: CID;
  responseCid: CID;
  metadataCid: CID;
  totalSize: number;
  blockCount: number;
}

export interface IPLDBuilder {
  /** Build individual message nodes */
  buildMessage(message: OpenAIChatMessage): Promise<CID>;
  buildRequest(request: OpenAIChatCompletionRequest): Promise<CID>;
  buildResponse(response: OpenAIChatCompletionResponse): Promise<CID>;
  /** Build complete conversation DAG */
  buildConversation(
    request: OpenAIChatCompletionRequest,
    response: OpenAIChatCompletionResponse,
    options?: BuildOptions
  ): Promise<ConversationRoot>;
  /** Get all blocks created by this builder */
  getBlocks(): Map<string, Uint8Array>;
  /** Clear all cached blocks */
  clearBlocks(): void;
}

// Import PromptCache type from prompt-cache module for compatibility
import type { PromptCache as PromptCacheType } from "./prompt-cache";
export type PromptCache = PromptCacheType;

export interface IPLDMetadata {
  shimVersion: string;
  captureTimestamp: number;
  encryption?: {
    encrypted: boolean;
    encryptedSymmetricKey?: string;
    accessControlConditions?: string;
  };
  compression?: {
    compressed: boolean;
    algorithm?: string;
    originalSize?: number;
  };
}

// ── IPLD Node Types ─────────────────────────────────────────────────────────

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
  parameters?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stream?: boolean;
  };
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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  created: number;
}

interface IPLDConversation {
  version: string;
  request: CID;
  response: CID;
  metadata: CID;
  timestamp: number;
  previousConversation?: { "/": string };
}

interface IPLDMetadataNode {
  shim_version: string;
  capture_timestamp: number;
  encryption?: {
    encrypted: boolean;
    encrypted_symmetric_key?: string;
    access_control_conditions?: string;
  };
  compression?: {
    compressed: boolean;
    algorithm?: string;
    original_size?: number;
  };
}

// ── Implementation ───────────────────────────────────────────────────────────

async function createBlock<T>(value: T): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagJson.encode(value);
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, hash);
  return { cid, bytes };
}

export function createIPLDBuilder(): IPLDBuilder {
  // Store blocks as CID string -> bytes
  const blocks = new Map<string, Uint8Array>();

  // In-memory cache for this builder instance
  const localMessageCache = new Map<string, CID>();

  const storeBlock = (cid: CID, bytes: Uint8Array): void => {
    blocks.set(cid.toString(), bytes);
  };

  const builder: IPLDBuilder = {
    async buildMessage(message: OpenAIChatMessage): Promise<CID> {
      // Create cache key from message content
      const cacheKey = JSON.stringify({ role: message.role, content: message.content });
      
      // Check local cache
      const cached = localMessageCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Convert message to IPLD format
      let ipldContent: string | IPLDContentPart[];
      
      if (typeof message.content === "string") {
        ipldContent = message.content;
      } else if (Array.isArray(message.content)) {
        ipldContent = message.content.map((part) => ({
          type: part.type,
          text: part.text,
          image_url: part.image_url,
        }));
      } else {
        ipldContent = "";
      }

      const ipldMessage: IPLDMessage = {
        role: message.role,
        content: ipldContent,
      };

      const { cid, bytes } = await createBlock(ipldMessage);
      storeBlock(cid, bytes);
      
      // Cache for deduplication
      localMessageCache.set(cacheKey, cid);
      
      return cid;
    },

    async buildRequest(request: OpenAIChatCompletionRequest): Promise<CID> {
      // Build message CIDs first
      const messageCids: CID[] = [];
      for (const message of request.messages) {
        const cid = await this.buildMessage(message);
        messageCids.push(cid);
      }

      const ipldRequest: IPLDRequest = {
        model: request.model,
        messages: messageCids,
      };

      // Add optional parameters if present
      const params: IPLDRequest["parameters"] = {};
      if (request.temperature !== undefined) params.temperature = request.temperature;
      if (request.max_tokens !== undefined) params.max_tokens = request.max_tokens;
      if (request.top_p !== undefined) params.top_p = request.top_p;
      if (request.frequency_penalty !== undefined) params.frequency_penalty = request.frequency_penalty;
      if (request.presence_penalty !== undefined) params.presence_penalty = request.presence_penalty;
      if (request.stream !== undefined) params.stream = request.stream;

      if (Object.keys(params).length > 0) {
        ipldRequest.parameters = params;
      }

      const { cid, bytes } = await createBlock(ipldRequest);
      storeBlock(cid, bytes);
      
      return cid;
    },

    async buildResponse(response: OpenAIChatCompletionResponse): Promise<CID> {
      // Build choice message CIDs
      const choiceCids: CID[] = [];
      for (const choice of response.choices) {
        const messageCid = await this.buildMessage(choice.message);
        
        const ipldChoice: IPLDChoice = {
          index: choice.index,
          message: messageCid,
          finish_reason: choice.finish_reason ?? "",
        };

        const { cid } = await createBlock(ipldChoice);
        choiceCids.push(cid);
      }

      const ipldResponse: IPLDResponse = {
        id: response.id,
        model: response.model,
        choices: choiceCids,
        created: response.created,
      };

      if (response.usage) {
        ipldResponse.usage = {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        };
      }

      const { cid, bytes } = await createBlock(ipldResponse);
      storeBlock(cid, bytes);
      
      return cid;
    },

    async buildConversation(
      request: OpenAIChatCompletionRequest,
      response: OpenAIChatCompletionResponse,
      options?: BuildOptions
    ): Promise<ConversationRoot> {
      const startTime = Date.now();
      const messageCids: CID[] = [];

      // Handle system prompt deduplication if cache is provided
      const messages = [...request.messages];
      if (options?.promptCache && messages.length > 0 && messages[0].role === "system") {
        const systemContent = typeof messages[0].content === "string" 
          ? messages[0].content 
          : JSON.stringify(messages[0].content);
        
        const cachedCid = await options.promptCache.get(systemContent);
        if (cachedCid) {
          // Use cached CID for system prompt
          messageCids.push(cachedCid);
          // Build remaining messages
          for (let i = 1; i < messages.length; i++) {
            const cid = await this.buildMessage(messages[i]);
            messageCids.push(cid);
          }
        } else {
          // Build all messages and cache the system prompt CID
          for (const message of messages) {
            const cid = await this.buildMessage(message);
            messageCids.push(cid);
          }
          // Cache the system prompt CID
          await options.promptCache.set(systemContent, messageCids[0]);
        }
      } else {
        // Build all messages normally
        for (const message of messages) {
          const cid = await this.buildMessage(message);
          messageCids.push(cid);
        }
      }

      // Build request (reuses message CIDs from cache)
      const requestCid = await this.buildRequest(request);

      // Build response
      const responseCid = await this.buildResponse(response);

      // Build metadata
      const metadata: IPLDMetadataNode = {
        shim_version: "2.0.0",
        capture_timestamp: startTime,
      };

      const { cid: metadataCid } = await createBlock(metadata);
      storeBlock(metadataCid, dagJson.encode(metadata));

      // Build conversation root
      const conversation: IPLDConversation = {
        version: "1.0.0",
        request: requestCid,
        response: responseCid,
        metadata: metadataCid,
        timestamp: startTime,
      };

      if (options?.previousConversation) {
        conversation.previousConversation = { "/": options.previousConversation.toString() };
      }

      const { cid: rootCid, bytes: rootBytes } = await createBlock(conversation);
      storeBlock(rootCid, rootBytes);

      // Calculate total size
      let totalSize = 0;
      for (const blockBytes of blocks.values()) {
        totalSize += blockBytes.length;
      }

      return {
        rootCid,
        messageCids,
        requestCid,
        responseCid,
        metadataCid,
        totalSize,
        blockCount: blocks.size,
      };
    },

    getBlocks(): Map<string, Uint8Array> {
      return new Map(blocks);
    },

    clearBlocks(): void {
      blocks.clear();
      localMessageCache.clear();
    },
  };

  return builder;
}

// ── CAR File Creation ───────────────────────────────────────────────────────

export interface CARFile {
  bytes: Uint8Array;
  rootCid: CID;
}

/**
 * Create a CAR file from IPLD blocks
 */
export async function createCAR(
  rootCid: CID,
  blocks: Map<string, Uint8Array>
): Promise<CARFile> {
  const { CarWriter } = await import("@ipld/car");
  
  const { writer, out } = CarWriter.create(rootCid);
  
  // Collect all blocks into the CAR
  for (const [cidStr, bytes] of blocks) {
    const cid = CID.parse(cidStr);
    await writer.put({ cid, bytes });
  }
  
  await writer.close();
  
  // Read the CAR bytes
  const chunks: Uint8Array[] = [];
  for await (const chunk of out) {
    chunks.push(chunk);
  }
  
  // Concatenate chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const carBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    carBytes.set(chunk, offset);
    offset += chunk.length;
  }
  
  return { bytes: carBytes, rootCid };
}
