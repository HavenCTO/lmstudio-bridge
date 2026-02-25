/**
 * Example middleware: logs request/response details.
 */

import { Middleware, RequestPayload, ResponsePayload, NextFunction } from "../types";

export const loggerMiddleware: Middleware = {
  name: "logger",

  async onRequest(payload: RequestPayload, next: NextFunction): Promise<void> {
    const { context, openaiRequest } = payload;
    console.log(
      `[logger] ➜ request ${context.requestId} | model=${openaiRequest.model} | messages=${openaiRequest.messages.length}`
    );
    await next();
  },

  async onResponse(payload: ResponsePayload, next: NextFunction): Promise<void> {
    const { context, lmstudioResponse, openaiResponse } = payload;
    const elapsed = Date.now() - context.receivedAt;
    console.log(
      `[logger] ← response ${context.requestId} | tokens=${lmstudioResponse.stats.total_output_tokens} | ${lmstudioResponse.stats.tokens_per_second.toFixed(1)} tok/s | ${elapsed}ms | finish=${openaiResponse.choices[0]?.finish_reason}`
    );
    await next();
  },
};