#!/usr/bin/env node
/**
 * LLM Client Bridge CLI
 *
 * Runs on the client side. Accepts OpenAI-compatible HTTP requests locally
 * and forwards them to the LLM Shim over WebRTC DataChannel or libp2p tunnel.
 *
 * Usage:
 *   llm-client-bridge --shim-url http://192.168.1.100:8081           # WebRTC mode
 *   llm-client-bridge --libp2p --peerid 12D3KooW...                  # Libp2p mode
 *   llm-client-bridge --libp2p --peerid 12D3KooW... --port 8080      # Custom port
 */

import { Command } from "commander";
import * as os from "os";
import express, { Request, Response } from "express";
import { generateToken } from "./protocol";
import { createSignalingServer } from "./signaling-server";
import { WebRTCClient } from "./webrtc-client";
import { createLibp2pBridge } from "./libp2p-bridge";
import {
  IpfsDaemonNotRunningError,
  Libp2pStreamMountingDisabledError,
  P2PProtocolInUseError,
  PeerIDUnreachableError,
  IpfsApiUrlError,
} from "./utils/ipfs-api";

const program = new Command();

program
  .name("llm-client-bridge")
  .description(
    "Client-side bridge that accepts OpenAI-compatible HTTP requests and proxies them to the LLM shim over WebRTC or libp2p"
  )
  .version("1.0.0")
  .option(
    "--shim-url <url>",
    "URL of the LLM shim's control server (required for WebRTC mode)"
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
  // ── Libp2p transport options ──
  .option("--libp2p", "Use libp2p transport (IPFS p2p tunnel)", false)
  .option(
    "--peerid <id>",
    "PeerID of the remote shim (required with --libp2p)"
  )
  .option(
    "--libp2p-protocol <name>",
    "Libp2p protocol name for the tunnel",
    "/x/llmshim"
  )
  .option(
    "--ipfs-api-url <url>",
    "Kubo IPFS daemon HTTP RPC API URL",
    "http://127.0.0.1:5001"
  )
  .parse(process.argv);

const opts = program.opts<{
  shimUrl?: string;
  port: string;
  host: string;
  signalingPort: string;
  timeout: string;
  // Libp2p
  libp2p: boolean;
  peerid?: string;
  libp2pProtocol: string;
  ipfsApiUrl: string;
}>();

// ── Mode selection ──
const mode = opts.libp2p ? "libp2p" : "webrtc";

if (mode === "webrtc" && !opts.shimUrl) {
  console.error("[main] ✗ --shim-url is required for WebRTC mode");
  process.exit(1);
}

if (mode === "libp2p" && !opts.peerid) {
  console.error("[main] ✗ --peerid is required when --libp2p is used");
  process.exit(1);
}

// Validate libp2p-specific flags
if (mode === "libp2p") {
  if (!opts.libp2pProtocol.startsWith("/x/")) {
    console.error(
      "Error: --libp2p-protocol must start with /x/ (e.g., /x/llmshim)"
    );
    process.exit(1);
  }
}

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
  console.log("║   OpenAI HTTP → LLM Shim            ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // ── Libp2p mode ──
  if (mode === "libp2p") {
    console.log(`[main] transport: libp2p`);
    console.log(`[main] connecting to PeerID: ${opts.peerid}`);

    const bridge = createLibp2pBridge({
      peerID: opts.peerid!,
      protocol: opts.libp2pProtocol,
      tunnelPort: 0, // auto-assign (will use 9191 default)
      proxyPort: parseInt(opts.port, 10),
      proxyHost: opts.host,
      ipfsApiUrl: opts.ipfsApiUrl,
      timeoutMs: parseInt(opts.timeout, 10),
    });
    await bridge.start();

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\n[main] shutting down…");
      await bridge.shutdown();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  // ── WebRTC mode (existing behavior) ──
  console.log(`[main] transport: webrtc`);

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
  // Known libp2p errors — print clean message without stack trace
  if (
    err instanceof IpfsDaemonNotRunningError ||
    err instanceof Libp2pStreamMountingDisabledError ||
    err instanceof P2PProtocolInUseError ||
    err instanceof PeerIDUnreachableError ||
    err instanceof IpfsApiUrlError
  ) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  // Unknown error — print with stack trace
  console.error("[main] fatal error:", err);
  process.exit(1);
});
