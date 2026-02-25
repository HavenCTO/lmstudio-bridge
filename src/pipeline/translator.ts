/**
 * Translators between OpenAI Chat Completions format and LM Studio /api/v1/chat format.
 */

import { v4 as uuidv4 } from "uuid";
import {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolCall,
  LMStudioChatRequest,
  LMStudioChatResponse,
  LMStudioInputItem,
  LMStudioMessageOutput,
  LMStudioToolCallOutput,
} from "../types";

/**
 * Convert OpenAI Chat Completion request → LM Studio /api/v1/chat request.
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
 * Convert LM Studio /api/v1/chat response → OpenAI Chat Completion response.
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
 * If the conversation is a single user text message, return a plain string.
 * Otherwise build an array of input items.
 */
function buildInput(
  messages: OpenAIChatMessage[]
): string | LMStudioInputItem[] {
  // Simple case: single user message with string content
  if (
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
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          items.push({ type: "message", content: part.text });
        } else if (part.type === "image_url" && part.image_url) {
          items.push({ type: "image", data_url: part.image_url.url });
        }
      }
    }
  }

  return items.length === 1 && items[0].type === "message"
    ? items[0].content
    : items;
}