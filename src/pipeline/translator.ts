/**
 * Translators between OpenAI Chat Completions format and LM Studio SDK format.
 */

import { v4 as uuidv4 } from "uuid";
import {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChunk,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolCall,
  LMStudioChatRequest,
  LMStudioChatResponse,
  LMStudioInputItem,
  LMStudioMessageOutput,
  LMStudioToolCallOutput,
} from "../types";
import { LMStudioStreamChunk } from "../client/lmstudio-client";

/**
 * Convert OpenAI Chat Completion request → LM Studio SDK request format.
 */
export function translateRequest(
  openai: OpenAIChatCompletionRequest
): LMStudioChatRequest {
  // Extract system message if present
  let systemPrompt: string | undefined;
  const nonSystemMessages: OpenAIChatMessage[] = [];

  for (const msg of openai.messages) {
    if (msg.role === "system") {
      // Concatenate multiple system messages
      const text = extractTextFromContent(msg.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // Build LM Studio input from remaining messages
  const input = buildInput(nonSystemMessages);

  const lmsReq: LMStudioChatRequest = {
    model: openai.model,
    input,
    stream: openai.stream ?? false,
  };

  if (systemPrompt) {
    lmsReq.system_prompt = systemPrompt;
  }
  if (openai.temperature !== undefined) {
    lmsReq.temperature = openai.temperature;
  }
  if (openai.top_p !== undefined) {
    lmsReq.top_p = openai.top_p;
  }
  if (openai.max_tokens !== undefined) {
    lmsReq.max_output_tokens = openai.max_tokens;
  }
  if (openai.frequency_penalty !== undefined) {
    lmsReq.repeat_penalty = openai.frequency_penalty;
  }

  return lmsReq;
}

/**
 * Convert LM Studio SDK response → OpenAI Chat Completion response.
 */
export function translateResponse(
  lms: LMStudioChatResponse,
  model: string
): OpenAIChatCompletionResponse {
  // Collect message content and tool calls from outputs
  let assistantContent = "";
  const toolCalls: OpenAIToolCall[] = [];

  for (const item of lms.output) {
    if (item.type === "message") {
      const msg = item as LMStudioMessageOutput;
      assistantContent += msg.content;
    } else if (item.type === "tool_call") {
      const tc = item as LMStudioToolCallOutput;
      toolCalls.push({
        id: `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: tc.tool,
          arguments: JSON.stringify(tc.arguments),
        },
      });
    }
    // reasoning and invalid_tool_call are not mapped to OpenAI format
  }

  const message: OpenAIChatMessage = {
    role: "assistant",
    content: assistantContent || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 29)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: lms.stats.input_tokens,
      completion_tokens: lms.stats.total_output_tokens,
      total_tokens: lms.stats.input_tokens + lms.stats.total_output_tokens,
    },
  };
}

// ── Helpers ──

function extractTextFromContent(
  content: string | OpenAIContentPart[] | null
): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/**
 * Build LM Studio input from an array of OpenAI messages.
 * Supports VLM images via image_url content parts.
 */
function buildInput(
  messages: OpenAIChatMessage[]
): string | LMStudioInputItem[] {
  // Check if we have any multi-modal content
  const hasMultiModalContent = messages.some(
    (msg) => Array.isArray(msg.content) && msg.content.some((p) => p.type === "image_url")
  );

  // Simple case: single user message with string content, no multi-modal
  if (
    !hasMultiModalContent &&
    messages.length === 1 &&
    messages[0].role === "user" &&
    typeof messages[0].content === "string"
  ) {
    return messages[0].content;
  }

  const items: LMStudioInputItem[] = [];

  for (const msg of messages) {
    if (msg.content === null) continue;

    if (typeof msg.content === "string") {
      // Prefix with role for context in multi-turn
      const prefix = msg.role !== "user" ? `[${msg.role}]: ` : "";
      items.push({ type: "message", content: `${prefix}${msg.content}` });
    } else if (Array.isArray(msg.content)) {
      // Multi-modal content: text + images
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          items.push({ type: "message", content: part.text });
        } else if (part.type === "image_url" && part.image_url) {
          // VLM: pass image data_url for SDK prepareImageBase64
          const imageUrl = part.image_url.url;
          items.push({ type: "image", data_url: imageUrl });
        }
      }
    }
  }

  return items.length === 1 && items[0].type === "message"
    ? items[0].content
    : items;
}

/**
 * Convert LM Studio stream chunk → OpenAI Chat Completion chunk.
 */
export function translateStreamingChunk(
  chunk: LMStudioStreamChunk,
  streamId: string,
  model: string,
  chunkIndex: number
): OpenAIChatCompletionChunk {
  const isFirstChunk = chunkIndex === 0;
  
  return {
    id: streamId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: isFirstChunk ? "assistant" : undefined,
          content: chunk.content || null,
        },
        finish_reason: chunk.finishReason,
      },
    ],
  };
}
