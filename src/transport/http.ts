/**
 * HTTP transport – Express server exposing OpenAI-compatible endpoints.
 */

import express, { Request, Response } from "express";
import { Engine } from "../pipeline/engine";
import { OpenAIChatCompletionRequest } from "../types";
import { translateRequest, translateStreamingChunk } from "../pipeline/translator";

export interface HttpTransportOptions {
  port: number;
  host: string;
}

const DEFAULTS: HttpTransportOptions = {
  port: 8080,
  host: "0.0.0.0",
};

export function createHttpTransport(
  engine: Engine,
  options?: Partial<HttpTransportOptions>
): { start: () => Promise<void>; app: express.Application } {
  const opts = { ...DEFAULTS, ...options };
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // ── Health endpoint ──
  app.get("/health", async (_req: Request, res: Response) => {
    const lmsOk = await engine.healthCheck();
    res.json({
      status: lmsOk ? "ok" : "degraded",
      lmstudio: lmsOk ? "reachable" : "unreachable",
      timestamp: new Date().toISOString(),
    });
  });

  // ── OpenAI-compatible Chat Completions ──
  app.post(
    "/v1/chat/completions",
    async (req: Request, res: Response) => {
      try {
        const body = req.body as OpenAIChatCompletionRequest;

        if (!body.model || !body.messages) {
          res.status(400).json({
            error: {
              message: "Missing required fields: model, messages",
              type: "invalid_request_error",
              code: "missing_required_fields",
            },
          });
          return;
        }

        if (body.stream) {
          // Handle streaming request
          await handleStreamingRequest(engine, body, res);
          return;
        }

        const response = await engine.handleChatCompletion(body);
        res.json(response);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        console.error(`[http] error processing request:`, err);
        res.status(502).json({
          error: {
            message: `LM Studio proxy error: ${message}`,
            type: "server_error",
            code: "proxy_error",
          },
        });
      }
    }
  );

  // ── OpenAI-compatible Models list (proxy to LM Studio) ──
  app.get("/v1/models", async (_req: Request, res: Response) => {
    try {
      const models = await engine.getModels();
      res.json(models);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[http] error fetching models:`, err);
      res.status(502).json({
        error: {
          message: `LM Studio proxy error: ${message}`,
          type: "server_error",
          code: "proxy_error",
        },
      });
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      const server = app.listen(opts.port, opts.host, () => {
        console.log(
          `[http] shim listening on http://${opts.host}:${opts.port}`
        );
        console.log(
          `[http] POST /v1/chat/completions for OpenAI-compatible requests (streaming supported)`
        );
        console.log(
          `[http] timeouts disabled - waiting indefinitely for LLM responses`
        );
        resolve();
      });

      // Disable all timeouts on the HTTP server to allow long-running LLM inference
      // server.timeout = 0 means no timeout (infinite)
      server.timeout = 0;
      // Keep-alive timeout - 0 disables it
      server.keepAliveTimeout = 0;
      // Headers timeout - 0 disables it  
      server.headersTimeout = 0;
      // Request timeout (Node 18+) - 0 disables it
      if ('requestTimeout' in server) {
        (server as any).requestTimeout = 0;
      }
    });
  };

  return { start, app };
}

/**
 * Handle streaming chat completion request using Server-Sent Events.
 */
async function handleStreamingRequest(
  engine: Engine,
  body: OpenAIChatCompletionRequest,
  res: Response
): Promise<void> {
  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = engine.handleChatCompletionStream(body);
    const model = body.model;

    for await (const chunk of stream) {
      const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
      res.write(sseData);
    }

    // Send final [DONE] marker
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[http] streaming error:`, err);
    
    // Send error in SSE format
    const errorChunk = {
      error: {
        message: `Streaming error: ${message}`,
        type: "server_error",
        code: "stream_error",
      },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.end();
  }
}