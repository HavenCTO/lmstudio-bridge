/**
 * HTTP transport – Express server exposing OpenAI-compatible endpoints.
 */

import express, { Request, Response } from "express";
import { Engine } from "../pipeline/engine";
import { OpenAIChatCompletionRequest } from "../types";

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
          // Streaming not yet supported – fall back to non-streaming
          console.warn(
            `[http] streaming requested but not yet implemented, falling back to non-streaming`
          );
          body.stream = false;
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

  // ── OpenAI-compatible Models list (passthrough placeholder) ──
  app.get("/v1/models", async (_req: Request, res: Response) => {
    res.json({
      object: "list",
      data: [],
    });
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      app.listen(opts.port, opts.host, () => {
        console.log(
          `[http] shim listening on http://${opts.host}:${opts.port}`
        );
        console.log(
          `[http] POST /v1/chat/completions for OpenAI-compatible requests`
        );
        resolve();
      });
    });
  };

  return { start, app };
}