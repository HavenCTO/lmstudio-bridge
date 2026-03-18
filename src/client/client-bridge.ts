/**
 * Client Bridge – unified entry point for client mode.
 *
 * Runs on the client side. Accepts OpenAI-compatible HTTP requests locally
 * and forwards them to a remote LLM Shim over WebRTC DataChannel or libp2p tunnel.
 *
 * This module is invoked from the main index.ts when mode === "client".
 */

import * as os from "os";
import express, { Request, Response } from "express";
import { generateToken } from "./protocol.js";
import { createSignalingServer } from "./signaling-server.js";
import { WebRTCClient } from "./webrtc-client.js";
import { createLibp2pClientBridge } from "./libp2p-client-bridge.js";
import type { ShimConfig } from "../config/types.js";

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

/**
 * Start the client bridge in WebRTC mode.
 *
 * 1. Creates a WebRTC PeerConnection + DataChannel
 * 2. Starts an ephemeral signaling server
 * 3. Sends a pair request to the remote shim
 * 4. Waits for WebRTC handshake
 * 5. Starts a local HTTP server that proxies requests over the DataChannel
 */
async function startWebRTCClient(cfg: ShimConfig): Promise<{ shutdown: () => Promise<void> }> {
  const shimUrl = cfg.clientBridge.shimUrl;
  if (!shimUrl) {
    throw new Error("clientBridge.shimUrl is required for WebRTC client mode");
  }

  const localIP = getLocalIP();
  const token = generateToken(24);
  const signalingPort = cfg.clientBridge.signalingPort;
  const requestTimeoutMs = cfg.clientBridge.timeoutMs;

  console.log(`[client] local IP: ${localIP}`);
  console.log(`[client] shim URL: ${shimUrl}`);

  // ── Step 1: Create WebRTC client ──
  let connectionReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    connectionReady = resolve;
  });

  const webrtcClient = new WebRTCClient(
    {
      onConnected: () => {
        console.log(`[client] WebRTC connected`);
      },
      onDisconnected: () => {
        console.warn(`[client] ✗ WebRTC disconnected`);
      },
      onHandshakeComplete: (version) => {
        console.log(`[client] ✓ handshake complete (protocol version: ${version})`);
        connectionReady();
      },
      onHandshakeFailed: (reason) => {
        console.error(`[client] ✗ handshake failed: ${reason}`);
      },
    },
    requestTimeoutMs
  );

  // ── Step 2: Create SDP offer (waits for ICE gathering) ──
  console.log(`[client] creating PeerConnection and gathering ICE candidates...`);
  const offerSdp = await webrtcClient.createOffer();

  // ── Step 3: Start ephemeral signaling server ──
  const signaling = createSignalingServer({
    port: signalingPort,
    token,
    host: "0.0.0.0", // Listen on all interfaces so shim can reach us
  });

  signaling.setOffer(offerSdp);
  const actualSignalingPort = await signaling.start();

  console.log(`[client] signaling server ready at http://0.0.0.0:${actualSignalingPort}`);
  console.log(`[client] pairing info: ip=${localIP}, port=${actualSignalingPort}, token=${token}`);

  // ── Step 4: Notify shim to pair ──
  console.log(`[client] sending pair request to shim at ${shimUrl}/pair...`);

  const pairResponse = await fetch(`${shimUrl}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ip: localIP,
      port: actualSignalingPort,
      token,
    }),
    signal: AbortSignal.timeout(65_000),
  });

  if (!pairResponse.ok) {
    const body = await pairResponse.text();
    throw new Error(`Pairing failed: ${pairResponse.status} ${body}`);
  }

  const pairResult = (await pairResponse.json()) as { paired: boolean; reason: string };
  console.log(`[client] pairing result: ${pairResult.reason}`);

  // ── Step 5: Wait for signaling answer and set it ──
  console.log(`[client] waiting for WebRTC handshake...`);
  await Promise.race([
    readyPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Handshake timeout (30s)")), 30_000)
    ),
  ]);

  console.log(`[client] ✓ WebRTC connection established and handshake complete`);

  // ── Step 6: Start local HTTP server for OpenAI-compatible requests ──
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Health endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: webrtcClient.isReady() ? "ok" : "degraded",
      mode: "client",
      transport: "webrtc",
      shimUrl,
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
          `[client] streaming not supported over WebRTC, falling back to non-streaming`
        );
        body.stream = false;
      }

      const response = await webrtcClient.sendRequest(body);
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[client] error:`, err);
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

  const httpPort = cfg.transport.port;
  const httpHost = cfg.clientBridge.localHost;

  let httpServer: any;
  await new Promise<void>((resolve) => {
    httpServer = app.listen(httpPort, httpHost, () => {
      console.log();
      console.log(`[client] ✓ local OpenAI-compatible API available at:`);
      console.log(`[client]   POST http://${httpHost}:${httpPort}/v1/chat/completions`);
      console.log(`[client]   GET  http://${httpHost}:${httpPort}/health`);
      console.log();
      console.log(`[client] client bridge is ready! (transport: webrtc)`);
      resolve();
    });
  });

  return {
    shutdown: async () => {
      webrtcClient.close();
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      await signaling.stop();
    },
  };
}

/**
 * Start the client bridge in libp2p mode.
 */
async function startLibp2pClient(cfg: ShimConfig): Promise<{ shutdown: () => Promise<void> }> {
  const peerID = cfg.clientBridge.peerID;
  if (!peerID) {
    throw new Error("clientBridge.peerID is required for libp2p client mode");
  }

  console.log(`[client] transport: libp2p`);
  console.log(`[client] connecting to PeerID: ${peerID}`);

  const bridge = createLibp2pClientBridge({
    peerID,
    protocol: cfg.libp2p.protocol,
    tunnelPort: 0, // auto-assign (will use 9191 default)
    proxyPort: cfg.transport.port,
    proxyHost: cfg.clientBridge.localHost,
    ipfsApiUrl: cfg.libp2p.ipfsApiUrl,
    timeoutMs: cfg.clientBridge.timeoutMs,
  });
  await bridge.start();

  return { shutdown: bridge.shutdown };
}

/**
 * Main entry point for client mode.
 * Called from index.ts when mode === "client".
 */
export async function startClientBridge(cfg: ShimConfig): Promise<{ shutdown: () => Promise<void> }> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     LLM Client Bridge v1.0.0        ║");
  console.log("║   OpenAI HTTP → Remote LLM Shim     ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  const clientTransport = cfg.clientBridge.transport;
  console.log(`[client] transport: ${clientTransport}`);

  if (clientTransport === "libp2p") {
    return startLibp2pClient(cfg);
  } else {
    return startWebRTCClient(cfg);
  }
}
