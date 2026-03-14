/**
 * Lightweight LM Studio mock for E2E testing.
 * Returns canned chat completion responses (streaming and non-streaming).
 *
 * NOTE: This mock is used by E2E tests run by QA/CI with Kubo installed.
 * The developer cannot run these tests locally (no Kubo binary).
 */

import express, { Request, Response } from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Models endpoint ──
app.get("/v1/models", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    data: [
      {
        id: "test-model",
        object: "model",
        created: Date.now(),
        owned_by: "lmstudio-mock",
      },
    ],
  });
});

// ── Chat Completions endpoint ──
app.post("/v1/chat/completions", (req: Request, res: Response) => {
  const body = req.body;

  if (!body.model || !body.messages) {
    res.status(400).json({
      error: {
        message: "Missing required fields: model, messages",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const userMessage =
    body.messages.find((m: any) => m.role === "user")?.content ?? "Hello";

  if (body.stream) {
    // Streaming (SSE) response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const id = `chatcmpl-mock-${Date.now()}`;
    const words = `Hello! You said: ${userMessage}`.split(" ");

    let index = 0;
    const interval = setInterval(() => {
      if (index < words.length) {
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { content: (index > 0 ? " " : "") + words[index] },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        index++;
      } else {
        // Final chunk with finish_reason
        const finalChunk = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        clearInterval(interval);
      }
    }, 50);

    req.on("close", () => clearInterval(interval));
  } else {
    // Non-streaming response
    res.json({
      id: `chatcmpl-mock-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `Hello! You said: ${userMessage}`,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    });
  }
});

// ── Health endpoint ──
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ── Start server ──
const PORT = parseInt(process.env.LMSTUDIO_MOCK_PORT || "1234", 10);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`[lmstudio-mock] listening on http://127.0.0.1:${PORT}`);
  console.log(`[lmstudio-mock] POST /v1/chat/completions (streaming + non-streaming)`);
  console.log(`[lmstudio-mock] GET /v1/models`);
});

server.timeout = 0;
server.keepAliveTimeout = 0;

export { app, server };
