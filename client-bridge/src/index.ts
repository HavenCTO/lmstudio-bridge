#!/usr/bin/env node
/**
 * LLM Client Bridge CLI
 *
 * Runs on the client side. Accepts OpenAI-compatible HTTP requests locally
 * and forwards them to the LLM Shim over a WebRTC DataChannel.
 *
 * Pairing flow:
 *   1. Client bridge starts ephemeral signaling server (GET /offer, POST /answer)
 *   2. Client bridge creates PeerConnection + DataChannel, gathers ICE
 *   3. Client bridge notifies the shim to pair (POST /pair to shim)
 *   4. Shim fetches offer, submits answer
 *   5. WebRTC DataChannel opens, handshake exchanged
 *   6. Client bridge starts local HTTP server for OpenAI-compatible requests
 *   7. Incoming HTTP requests → DataChannel → Shim → LM Studio → response
 *
 * Usage:
 *   llm-client-bridge --shim-url http://192.168.1.100:8081
 *   llm-client-bridge --shim-url http://192.168.1.100:8081 --port 8080
 */

import { Command } from "commander";
import * as os from "os";
import express, { Request, Response } from "express";
import { generateToken } from "./protocol";
import { createSignalingServer } from "./signaling-server";
import { WebRTCClient } from "./webrtc-client";

const program = new Command();

program
  .name("llm-client-bridge")
  .description(
    "Client-side bridge that accepts OpenAI-compatible HTTP requests and proxies them to the LLM shim over WebRTC"
  )
  .version("1.0.0")
  .requiredOption(
    "--shim-url <url>",
    "URL of the LLM shim's control server (e.g., http://192.168.1.100:8081)"
  )
  .option("--port <number>", "Port for the local OpenAI-compatible HTTP server", "8080")
  .option("--host <address>", "Bind address for the local HTTP server", "127.0.0.1")
  .option(
    "--signaling-port <number>",
    "Port for the ephemeral signaling server (0 = random)",
    "0"
  )
  .option(
    "--timeout <ms>",
    "Request timeout for LLM requests in ms",
    "120000"
  )
  .parse(process.argv);

const opts = program.opts<{
  shimUrl: string;
  port: string;
  host: string;
  signalingPort: string;
  timeout: string;
}>();

/**
 * Get the local IP address (first non-internal IPv4 address).
 */
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     LLM Client Bridge v1.0.0        ║");
  console.log("║   OpenAI HTTP → WebRTC → Shim       ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  const localIP = getLocalIP();
  const token = generateToken(24);
  const signalingPort = parseInt(opts.signalingPort, 10);
  const requestTimeoutMs = parseInt(opts.timeout, 10);

  console.log(`[main] local IP: ${localIP}`);
  console.log(`[main] shim URL: ${opts.shimUrl}`);

  // ── Step 1: Create WebRTC client ──
  let connectionReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    connectionReady = resolve;
  });

  const webrtcClient = new WebRTCClient(
    {
      onConnected: () => {
        console.log(`[main] WebRTC connected`);
      },
      onDisconnected: () => {
        console.warn(`[main] ✗ WebRTC disconnected`);
      },
      onHandshakeComplete: (version) => {
        console.log(`[main] ✓ handshake complete (protocol version: ${version})`);
        connectionReady();
      },
      onHandshakeFailed: (reason) => {
        console.error(`[main] ✗ handshake failed: ${reason}`);
      },
    },
    requestTimeoutMs
  );

  // ── Step 2: Create SDP offer (waits for ICE gathering) ──
  console.log(`[main] creating PeerConnection and gathering ICE candidates...`);
  const offerSdp = await webrtcClient.createOffer();

  // ── Step 3: Start ephemeral signaling server ──
  const signaling = createSignalingServer({
    port: signalingPort,
    token,
    host: "0.0.0.0", // Listen on all interfaces so shim can reach us
  });

  signaling.setOffer(offerSdp);
  const actualSignalingPort = await signaling.start();

  console.log(`[main] signaling server ready at http://0.0.0.0:${actualSignalingPort}`);
  console.log(`[main] pairing info: ip=${localIP}, port=${actualSignalingPort}, token=${token}`);

  // ── Step 4: Notify shim to pair ──
  console.log(`[main] sending pair request to shim at ${opts.shimUrl}/pair...`);

  const pairResponse = await fetch(`${opts.shimUrl}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ip: localIP,
      port: actualSignalingPort,
      token,
    }),
    signal: AbortSignal.timeout(65_000), // Slightly more than signaling timeout
  });

  if (!pairResponse.ok) {
    const body = await pairResponse.text();
    throw new Error(`Pairing failed: ${pairResponse.status} ${body}`);
  }

  const pairResult = (await pairResponse.json()) as { paired: boolean; reason: string };
  console.log(`[main] pairing result: ${pairResult.reason}`);

  // ── Step 5: Wait for signaling answer and set it ──
  // The shim will have already fetched the offer and submitted the answer
  // during the /pair call. The signaling server received it and the
  // WebRTC connection should be establishing.

  // Wait for handshake to complete
  console.log(`[main] waiting for WebRTC handshake...`);
  await Promise.race([
    readyPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Handshake timeout (30s)")), 30_000)
    ),
  ]);

  console.log(`[main] ✓ WebRTC connection established and handshake complete`);

  // ── Step 6: Start local HTTP server for OpenAI-compatible requests ──
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Health endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: webrtcClient.isReady() ? "ok" : "degraded",
      transport: "webrtc",
      shimUrl: opts.shimUrl,
      webrtcConnected: webrtcClient.isReady(),
    });
  });

  // OpenAI-compatible Chat Completions endpoint
  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    try {
      const body = req.body;

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

      if (!webrtcClient.isReady()) {
        res.status(503).json({
          error: {
            message: "WebRTC connection to shim is not ready",
            type: "server_error",
            code: "connection_not_ready",
          },
        });
        return;
      }

      if (body.stream) {
        console.warn(
          `[http] streaming not supported over WebRTC, falling back to non-streaming`
        );
        body.stream = false;
      }

      const response = await webrtcClient.sendRequest(body);
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[http] error:`, err);
      res.status(502).json({
        error: {
          message: `WebRTC proxy error: ${message}`,
          type: "server_error",
          code: "proxy_error",
        },
      });
    }
  });

  // Models list placeholder
  app.get("/v1/models", (_req: Request, res: Response) => {
    res.json({
      object: "list",
      data: [],
    });
  });

  const httpPort = parseInt(opts.port, 10);
  const httpHost = opts.host;

  await new Promise<void>((resolve) => {
    app.listen(httpPort, httpHost, () => {
      console.log();
      console.log(`[main] ✓ local OpenAI-compatible API available at:`);
      console.log(`[main]   POST http://${httpHost}:${httpPort}/v1/chat/completions`);
      console.log(`[main]   GET  http://${httpHost}:${httpPort}/health`);
      console.log();
      console.log(`[main] client bridge is ready!`);
      resolve();
    });
  });
}

main().catch((err) => {
  console.error("[main] fatal error:", err);
  process.exit(1);
});