/**
 * LM Studio SDK client for chat completion with VLM support.
 * Uses @lmstudio/sdk for proper Vision-Language Model handling.
 */

import { LMStudioClient as SDKClient, Chat, FileHandle } from "@lmstudio/sdk";
import {
  LMStudioChatRequest,
  LMStudioChatResponse,
  LMStudioInputItem,
} from "../types";

/** Streaming chunk from LM Studio prediction */
export interface LMStudioStreamChunk {
  content: string;
  finishReason: "stop" | "length" | null;
}

export interface LMStudioClientOptions {
  /** Base URL, default http://localhost:1234 */
  baseUrl: string;
  /** Optional API token */
  apiToken?: string;
  /** Request timeout in ms, default 0 (no timeout / infinite) */
  timeoutMs: number;
}

const DEFAULTS: LMStudioClientOptions = {
  baseUrl: "http://localhost:1234",
  timeoutMs: 0,
};

export class LMStudioClient {
  private options: LMStudioClientOptions;
  private sdkClient: SDKClient;

  constructor(options?: Partial<LMStudioClientOptions>) {
    this.options = { ...DEFAULTS, ...options };
    
    // LM Studio SDK requires WebSocket URL - convert from HTTP
    let wsUrl = this.options.baseUrl;
    if (wsUrl.startsWith("http://")) {
      wsUrl = wsUrl.replace("http://", "ws://");
    } else if (wsUrl.startsWith("https://")) {
      wsUrl = wsUrl.replace("https://", "wss://");
    }
    
    console.log(`[lmstudio-client] targeting ${wsUrl}`);

    // Initialize SDK client with WebSocket URL
    this.sdkClient = new SDKClient({
      baseUrl: wsUrl,
    });
  }

  /**
   * Send a chat request to LM Studio and return the response.
   * Uses SDK with proper VLM image handling.
   */
  async chat(request: LMStudioChatRequest): Promise<LMStudioChatResponse> {
    // Get the model - use specified model or any available
    const model = request.model
      ? await this.sdkClient.llm.model(request.model)
      : await this.sdkClient.llm.model();

    // Build SDK Chat from our request (async because of image preparation)
    const chat = await this.buildChat(request);

    // Configure prediction options
    const predictionOpts: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      predictionOpts.temperature = request.temperature;
    }
    if (request.max_output_tokens !== undefined) {
      predictionOpts.maxTokens = request.max_output_tokens;
    }
    if (request.top_p !== undefined) {
      predictionOpts.topPSampling = request.top_p;
    }
    if (request.repeat_penalty !== undefined) {
      predictionOpts.repeatPenalty = request.repeat_penalty;
    }

    // Get prediction
    const prediction = model.respond(chat, predictionOpts);

    // Wait for result with optional timeout
    let result;
    if (this.options.timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`LM Studio request timed out after ${this.options.timeoutMs}ms`)),
          this.options.timeoutMs
        );
      });
      result = await Promise.race([prediction.result(), timeoutPromise]);
    } else {
      result = await prediction.result();
    }

    // Convert SDK result to our response format
    return this.convertResultToResponse(result);
  }

  /**
   * Stream a chat request to LM Studio and yield chunks as they arrive.
   * Uses SDK's async iteration for proper streaming support.
   */
  async *chatStream(request: LMStudioChatRequest): AsyncGenerator<LMStudioStreamChunk> {
    // Get the model - use specified model or any available
    const model = request.model
      ? await this.sdkClient.llm.model(request.model)
      : await this.sdkClient.llm.model();

    // Build SDK Chat from our request (async because of image preparation)
    const chat = await this.buildChat(request);

    // Configure prediction options
    const predictionOpts: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      predictionOpts.temperature = request.temperature;
    }
    if (request.max_output_tokens !== undefined) {
      predictionOpts.maxTokens = request.max_output_tokens;
    }
    if (request.top_p !== undefined) {
      predictionOpts.topPSampling = request.top_p;
    }
    if (request.repeat_penalty !== undefined) {
      predictionOpts.repeatPenalty = request.repeat_penalty;
    }

    // Get prediction with streaming
    const prediction = model.respond(chat, predictionOpts);

    // Stream chunks using async iterator with optional timeout
    let contentBuffer = "";
    try {
      if (this.options.timeoutMs > 0) {
        // With timeout - need to wrap the iterator
        const timeoutMs = this.options.timeoutMs;
        const iterator = prediction[Symbol.asyncIterator]();
        
        while (true) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`LM Studio stream timed out after ${timeoutMs}ms`)), timeoutMs);
          });
          
          const { value, done } = await Promise.race([iterator.next(), timeoutPromise]);
          if (done) break;
          
          const chunk = value as { content?: string };
          if (chunk.content) {
            contentBuffer += chunk.content;
            yield { content: chunk.content, finishReason: null };
          }
        }
      } else {
        // No timeout - stream directly
        for await (const chunk of prediction) {
          const content = (chunk as { content?: string }).content;
          if (content) {
            contentBuffer += content;
            yield { content, finishReason: null };
          }
        }
      }
      
      // Final chunk with finish_reason
      yield { content: "", finishReason: "stop" };
    } catch (err) {
      console.error(`[lmstudio-client] streaming error:`, err);
      yield { content: "", finishReason: "stop" };
    }
  }

  /**
   * Build SDK Chat object from our request format.
   * Async due to image preparation.
   */
  private async buildChat(request: LMStudioChatRequest): Promise<Chat> {
    const chat = Chat.empty();

    // Add system prompt if present
    if (request.system_prompt) {
      chat.append("system", request.system_prompt);
    }

    // Build messages from input
    const input = request.input;
    if (typeof input === "string") {
      // Simple text input
      chat.append("user", input);
    } else if (Array.isArray(input)) {
      // Array of input items - handle text and images
      const textParts: string[] = [];
      const imageHandles: FileHandle[] = [];

      for (const item of input) {
        if (item.type === "message") {
          textParts.push((item as LMStudioInputItem & { type: "message"; content: string }).content);
        } else if (item.type === "image") {
          // VLM: prepare image from data_url
          const imageUrl = (item as LMStudioInputItem & { type: "image"; data_url: string }).data_url;
          const handle = await this.prepareImageFromDataUrl(imageUrl);
          if (handle) {
            imageHandles.push(handle);
          }
        }
      }

      // Append message with images if any
      const content = textParts.join("\n");
      if (imageHandles.length > 0) {
        chat.append("user", content, { images: imageHandles });
      } else if (textParts.length > 0) {
        chat.append("user", content);
      }
    }

    return chat;
  }

  /**
   * Prepare image from a data URL (data:image/xxx;base64,...).
   * Returns FileHandle for SDK usage.
   */
  private async prepareImageFromDataUrl(dataUrl: string): Promise<FileHandle | null> {
    try {
      // Parse data URL format: data:image/png;base64,ABC123...
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        console.warn(`[lmstudio-client] invalid image data URL format`);
        return null;
      }

      const mimeType = match[1];
      const base64Content = match[2];

      // Determine file extension from MIME type
      const ext = this.mimeTypeToExtension(mimeType);
      const fileName = `image.${ext}`;

      // Use SDK to prepare image from base64
      return await this.sdkClient.files.prepareImageBase64(fileName, base64Content);
    } catch (err) {
      console.warn(`[lmstudio-client] failed to prepare image:`, err);
      return null;
    }
  }

  /**
   * Convert MIME type to file extension.
   */
  private mimeTypeToExtension(mimeType: string): string {
    const map: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/bmp": "bmp",
    };
    return map[mimeType] || "bin";
  }

  /**
   * Convert SDK prediction result to our response format.
   * SDK stats use different names: promptTokensCount, predictedTokensCount, totalTokensCount
   */
  private convertResultToResponse(result: {
    content?: string;
    reasoningContent?: string;
    stats?: {
      promptTokensCount?: number;
      predictedTokensCount?: number;
      totalTokensCount?: number;
      tokensPerSecond?: number;
      timeToFirstTokenSec?: number;
    };
    modelInfo?: {
      identifier?: string;
    };
  }): LMStudioChatResponse {
    const output: LMStudioChatResponse["output"] = [];

    // Add message content if present (use nonReasoningContent to exclude reasoning)
    const content = result.content ?? "";
    if (content) {
      output.push({
        type: "message",
        content,
      });
    }

    // Extract stats with correct SDK property names
    const stats = result.stats || {};
    const inputTokens = stats.promptTokensCount ?? 0;
    const outputTokens = stats.predictedTokensCount ?? 0;

    return {
      model_instance_id: result.modelInfo?.identifier ?? "unknown",
      output,
      stats: {
        input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        reasoning_output_tokens: 0,
        tokens_per_second: stats.tokensPerSecond ?? 0,
        time_to_first_token_seconds: stats.timeToFirstTokenSec ?? 0,
      },
    };
  }

  /**
   * Health check – tries to reach LM Studio.
   */
  async ping(): Promise<boolean> {
    try {
      // Try to list models as a health check
      await this.sdkClient.llm.listLoaded();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get list of models from LM Studio.
   */
  async getModels(): Promise<{ object: string; data: any[] }> {
    try {
      const models = await this.sdkClient.llm.listLoaded();
      return {
        object: "list",
        data: models.map(m => ({
          id: m.identifier,
          object: "model",
          owned_by: "lm-studio",
        })),
      };
    } catch (err: unknown) {
      console.error(`[lmstudio-client] failed to get models:`, err);
      return { object: "list", data: [] };
    }
  }
}
