/**
 * Core engine: ties together translation, middleware pipeline, and LM Studio client.
 */

import { v4 as uuidv4 } from "uuid";
import {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  ShimContext,
  RequestPayload,
  ResponsePayload,
  Middleware,
} from "../types";
import { MiddlewareRunner } from "./middleware-runner";
import { translateRequest, translateResponse } from "./translator";
import { LMStudioClient, LMStudioClientOptions } from "../client/lmstudio-client";

export interface EngineOptions {
  lmstudio?: Partial<LMStudioClientOptions>;
  middlewares?: Middleware[];
}

export class Engine {
  private pipeline: MiddlewareRunner;
  private client: LMStudioClient;

  constructor(options?: EngineOptions) {
    this.pipeline = new MiddlewareRunner();
    this.client = new LMStudioClient(options?.lmstudio);

    if (options?.middlewares) {
      for (const mw of options.middlewares) {
        this.pipeline.use(mw);
      }
    }
  }

  /** Register additional middleware after construction */
  use(mw: Middleware): void {
    this.pipeline.use(mw);
  }

  /**
   * Process an OpenAI-compatible chat completion request end-to-end:
   *   1. Translate OpenAI → LM Studio format
   *   2. Run request middleware
   *   3. Call LM Studio
   *   4. Translate LM Studio → OpenAI format
   *   5. Run response middleware
   *   6. Return OpenAI-compatible response
   */
  async handleChatCompletion(
    openaiReq: OpenAIChatCompletionRequest
  ): Promise<OpenAIChatCompletionResponse> {
    const context: ShimContext = {
      requestId: uuidv4(),
      receivedAt: Date.now(),
      metadata: {},
    };

    // Step 1: Translate request
    const lmsRequest = translateRequest(openaiReq);

    // Step 2: Run request middleware
    const reqPayload: RequestPayload = {
      openaiRequest: openaiReq,
      lmstudioRequest: lmsRequest,
      context,
    };
    await this.pipeline.runRequest(reqPayload);

    // Step 3: Call LM Studio
    const lmsResponse = await this.client.chat(reqPayload.lmstudioRequest);

    // Step 4: Translate response
    const openaiResp = translateResponse(lmsResponse, openaiReq.model);

    // Step 5: Run response middleware
    const respPayload: ResponsePayload = {
      lmstudioResponse: lmsResponse,
      openaiResponse: openaiResp,
      context,
    };
    await this.pipeline.runResponse(respPayload);

    // Step 6: Return (possibly mutated) response
    return respPayload.openaiResponse;
  }

  /** Check if LM Studio is reachable */
  async healthCheck(): Promise<boolean> {
    return this.client.ping();
  }
}