/**
 * Streaming IPLD Builder Module
 *
 * Builds IPLD DAGs from streaming data for real-time processing.
 * Supports incremental block creation without waiting for complete responses.
 *
 * @module streaming-ipld
 */

import { CID } from "multiformats/cid";
import * as dagJson from "@ipld/dag-json";
import { sha256 } from "multiformats/hashes/sha2";
import { OpenAIChatMessage, OpenAIChatCompletionChunk } from "../types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResponseChunk {
  index: number;
  content: string;
  finishReason?: string;
  timestamp: number;
}

export interface StreamingMessageBuilder {
  role: string;
  content: string;
  chunks: ResponseChunk[];
  startedAt: number;
  lastChunkAt: number;
}

export interface StreamingBuilderState {
  requestCid?: CID;
  responseChunks: Map<number, ResponseChunk>;
  messageBuilders: Map<number, StreamingMessageBuilder>;
  startedAt: number;
  finalized: boolean;
}

export interface StreamingIPLDBuilder {
  /** Start building from a request (can be called immediately) */
  startRequest(request: {
    model: string;
    messages: OpenAIChatMessage[];
    parameters?: Record<string, unknown>;
  }): Promise<CID>;
  
  /** Stream a response chunk as it arrives */
  streamResponseChunk(chunk: OpenAIChatCompletionChunk): Promise<CID | null>;
  
  /** Stream a message (for non-streaming responses) */
  streamMessage(message: OpenAIChatMessage, index: number): Promise<CID>;
  
  /** Finalize and get the root CID */
  finalize(responseMetadata: {
    id: string;
    model: string;
    created: number;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }): Promise<{
    rootCid: CID;
    blockCount: number;
    totalSize: number;
  }>;
  
  /** Get all blocks created so far */
  getBlocks(): Map<string, Uint8Array>;
  
  /** Check if builder has finalized */
  isFinalized(): boolean;
  
  /** Get current state for progress tracking */
  getState(): StreamingBuilderState;
  
  /** Abort and cleanup */
  abort(): void;
}

// ── Implementation ───────────────────────────────────────────────────────────

async function createBlock<T>(value: T): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagJson.encode(value);
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, hash);
  return { cid, bytes };
}

export function createStreamingIPLDBuilder(): StreamingIPLDBuilder {
  const blocks = new Map<string, Uint8Array>();
  const state: StreamingBuilderState = {
    responseChunks: new Map(),
    messageBuilders: new Map(),
    startedAt: Date.now(),
    finalized: false,
  };

  let aborted = false;

  const storeBlock = (cid: CID, bytes: Uint8Array): void => {
    blocks.set(cid.toString(), bytes);
  };

  const builder: StreamingIPLDBuilder = {
    async startRequest(request: {
      model: string;
      messages: OpenAIChatMessage[];
      parameters?: Record<string, unknown>;
    }): Promise<CID> {
      if (aborted) {
        throw new Error("Builder has been aborted");
      }

      // Build message CIDs for request
      const messageCids: CID[] = [];
      for (const message of request.messages) {
        const ipldMessage = {
          role: message.role,
          content: typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        };
        const { cid, bytes } = await createBlock(ipldMessage);
        storeBlock(cid, bytes);
        messageCids.push(cid);
      }

      // Build request node
      const ipldRequest = {
        model: request.model,
        messages: messageCids,
        parameters: request.parameters,
      };

      const { cid, bytes } = await createBlock(ipldRequest);
      storeBlock(cid, bytes);
      state.requestCid = cid;

      return cid;
    },

    async streamResponseChunk(
      chunk: OpenAIChatCompletionChunk
    ): Promise<CID | null> {
      if (aborted || state.finalized) {
        return null;
      }

      const choice = chunk.choices[0];
      if (!choice) return null;

      const index = choice.index;
      const content = choice.delta?.content ?? "";
      const finishReason = choice.finish_reason ?? undefined;

      // Get or create message builder for this choice index
      let messageBuilder = state.messageBuilders.get(index);
      if (!messageBuilder) {
        messageBuilder = {
          role: "assistant",
          content: "",
          chunks: [],
          startedAt: Date.now(),
          lastChunkAt: Date.now(),
        };
        state.messageBuilders.set(index, messageBuilder);
      }

      // Create chunk
      const responseChunk: ResponseChunk = {
        index: messageBuilder.chunks.length,
        content,
        finishReason,
        timestamp: Date.now(),
      };

      messageBuilder.chunks.push(responseChunk);
      messageBuilder.content += content;
      messageBuilder.lastChunkAt = Date.now();

      // Store chunk as separate block for granular access
      const { cid, bytes } = await createBlock(responseChunk);
      storeBlock(cid, bytes);

      state.responseChunks.set(responseChunk.index, responseChunk);

      return cid;
    },

    async streamMessage(
      message: OpenAIChatMessage,
      index: number
    ): Promise<CID> {
      if (aborted) {
        throw new Error("Builder has been aborted");
      }

      const ipldMessage = {
        role: message.role,
        content: typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      };

      const { cid, bytes } = await createBlock(ipldMessage);
      storeBlock(cid, bytes);

      // Track as a message builder
      const messageBuilder: StreamingMessageBuilder = {
        role: message.role,
        content: ipldMessage.content as string,
        chunks: [
          {
            index: 0,
            content: ipldMessage.content as string,
            timestamp: Date.now(),
          },
        ],
        startedAt: Date.now(),
        lastChunkAt: Date.now(),
      };

      state.messageBuilders.set(index, messageBuilder);

      return cid;
    },

    async finalize(responseMetadata: {
      id: string;
      model: string;
      created: number;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    }): Promise<{
      rootCid: CID;
      blockCount: number;
      totalSize: number;
    }> {
      if (aborted) {
        throw new Error("Builder has been aborted");
      }

      if (state.finalized) {
        throw new Error("Builder has already been finalized");
      }

      if (!state.requestCid) {
        throw new Error("Request must be started before finalizing");
      }

      // Build message nodes from accumulated chunks
      const messageCids: CID[] = [];
      const sortedBuilders = Array.from(state.messageBuilders.entries())
        .sort((a, b) => a[0] - b[0]);

      for (const [, builder] of sortedBuilders) {
        const ipldMessage = {
          role: builder.role,
          content: builder.content,
          chunkCount: builder.chunks.length,
        };

        const { cid, bytes } = await createBlock(ipldMessage);
        storeBlock(cid, bytes);
        messageCids.push(cid);
      }

      // Build choices
      const choiceCids: CID[] = [];
      for (let i = 0; i < messageCids.length; i++) {
        const ipldChoice = {
          index: i,
          message: messageCids[i],
          finish_reason: "stop", // Could be more specific
        };

        const { cid, bytes } = await createBlock(ipldChoice);
        storeBlock(cid, bytes);
        choiceCids.push(cid);
      }

      // Build response
      const ipldResponse = {
        id: responseMetadata.id,
        model: responseMetadata.model,
        choices: choiceCids,
        created: responseMetadata.created,
        usage: responseMetadata.usage,
      };

      const { cid: responseCid, bytes: responseBytes } = await createBlock(ipldResponse);
      storeBlock(responseCid, responseBytes);

      // Build metadata
      const ipldMetadata = {
        shim_version: "2.0.0",
        capture_timestamp: state.startedAt,
        finalized_at: Date.now(),
        streaming: true,
        total_chunks: state.responseChunks.size,
      };

      const { cid: metadataCid, bytes: metadataBytes } = await createBlock(ipldMetadata);
      storeBlock(metadataCid, metadataBytes);

      // Build conversation root
      const ipldConversation = {
        version: "1.0.0",
        request: state.requestCid,
        response: responseCid,
        metadata: metadataCid,
        timestamp: state.startedAt,
      };

      const { cid: rootCid, bytes: rootBytes } = await createBlock(ipldConversation);
      storeBlock(rootCid, rootBytes);

      state.finalized = true;

      // Calculate total size
      let totalSize = 0;
      for (const blockBytes of blocks.values()) {
        totalSize += blockBytes.length;
      }

      return {
        rootCid,
        blockCount: blocks.size,
        totalSize,
      };
    },

    getBlocks(): Map<string, Uint8Array> {
      return new Map(blocks);
    },

    isFinalized(): boolean {
      return state.finalized;
    },

    getState(): StreamingBuilderState {
      // Return a copy of state
      return {
        requestCid: state.requestCid,
        responseChunks: new Map(state.responseChunks),
        messageBuilders: new Map(state.messageBuilders),
        startedAt: state.startedAt,
        finalized: state.finalized,
      };
    },

    abort(): void {
      aborted = true;
      state.finalized = true;
      blocks.clear();
    },
  };

  return builder;
}

// ── Async Iterator Helpers ───────────────────────────────────────────────────

/**
 * Process a stream of response chunks into IPLD blocks
 */
export async function* streamToIPLDBlocks(
  chunkStream: AsyncIterable<OpenAIChatCompletionChunk>
): AsyncGenerator<{ type: "chunk"; cid: CID; index: number }> {
  const builder = createStreamingIPLDBuilder();

  for await (const chunk of chunkStream) {
    const cid = await builder.streamResponseChunk(chunk);
    if (cid) {
      yield { type: "chunk", cid, index: chunk.choices[0]?.index ?? 0 };
    }
  }
}

/**
 * Upload blocks as they're created (streaming upload)
 */
export async function uploadBlocksStreaming(
  blocks: AsyncIterable<{ cid: CID; bytes: Uint8Array }>,
  uploadFn: (blocks: Map<string, Uint8Array>) => Promise<string>
): Promise<string> {
  const batch = new Map<string, Uint8Array>();
  const batchSize = 10; // Upload every 10 blocks

  for await (const block of blocks) {
    batch.set(block.cid.toString(), block.bytes);

    if (batch.size >= batchSize) {
      await uploadFn(new Map(batch));
      batch.clear();
    }
  }

  // Upload remaining blocks
  if (batch.size > 0) {
    return await uploadFn(batch);
  }

  throw new Error("No blocks to upload");
}

// ── Performance Monitoring ───────────────────────────────────────────────────

export interface StreamingMetrics {
  chunksProcessed: number;
  blocksCreated: number;
  bytesAccumulated: number;
  timeToFirstBlock: number;
  totalTime: number;
}

export function createStreamingMetrics(): {
  recordChunk: () => void;
  recordBlock: (bytes: number) => void;
  finalize: () => StreamingMetrics;
} {
  const startTime = Date.now();
  let firstBlockTime: number | null = null;
  let chunksProcessed = 0;
  let blocksCreated = 0;
  let bytesAccumulated = 0;

  return {
    recordChunk() {
      chunksProcessed++;
    },
    recordBlock(bytes: number) {
      if (firstBlockTime === null) {
        firstBlockTime = Date.now() - startTime;
      }
      blocksCreated++;
      bytesAccumulated += bytes;
    },
    finalize() {
      return {
        chunksProcessed,
        blocksCreated,
        bytesAccumulated,
        timeToFirstBlock: firstBlockTime ?? 0,
        totalTime: Date.now() - startTime,
      };
    },
  };
}
