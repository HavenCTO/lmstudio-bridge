/**
 * Middleware pipeline types.
 *
 * Middleware can intercept/transform at two stages:
 *   1. onRequest  – after receiving OpenAI request, before sending to LM Studio
 *   2. onResponse – after receiving LM Studio response, before sending back to caller
 */

import { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "./openai";
import { LMStudioChatRequest, LMStudioChatResponse } from "./lmstudio";

export interface ShimContext {
  /** Unique request ID */
  requestId: string;
  /** Timestamp when the request was received */
  receivedAt: number;
  /** Arbitrary metadata middleware can attach */
  metadata: Record<string, unknown>;
}

export interface RequestPayload {
  /** The original OpenAI-format request */
  openaiRequest: OpenAIChatCompletionRequest;
  /** The translated LM Studio request (middleware can mutate this) */
  lmstudioRequest: LMStudioChatRequest;
  /** Shared context */
  context: ShimContext;
}

export interface ResponsePayload {
  /** The raw LM Studio response */
  lmstudioResponse: LMStudioChatResponse;
  /** The translated OpenAI-format response (middleware can mutate this) */
  openaiResponse: OpenAIChatCompletionResponse;
  /** Shared context (same instance as request phase) */
  context: ShimContext;
}

export type NextFunction = () => Promise<void>;

export interface Middleware {
  /** Human-readable name for logging */
  name: string;
  /** Called before the request is sent to LM Studio */
  onRequest?: (payload: RequestPayload, next: NextFunction) => Promise<void>;
  /** Called after the response is received from LM Studio */
  onResponse?: (payload: ResponsePayload, next: NextFunction) => Promise<void>;
}