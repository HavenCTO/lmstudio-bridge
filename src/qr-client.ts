#!/usr/bin/env node
/**
 * WebRTC Client with QR-code signaling (no HTTP between machines).
 *
 * This runs on the CLIENT computer (the one that wants to use the LLM).
 * It accepts the server's SDP offer (pasted from QR scan), generates
 * an answer, displays it as QR, and then exposes a local HTTP API.
 *
 * Usage:
 *   node dist/qr-client.js [--port 8080]
 *
 * Flow:
 *   1. User pastes compressed SDP offer from server
 *   2. Creates PeerConnection, sets remote offer, generates answer
 *   3. Displays compressed answer as QR code
 *   4. WebRTC DataChannel connects
 *   5. Starts local HTTP proxy on 127.0.0.1:<port>
 */

import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  DATACHANNEL_LABEL,
  DATACHANNEL_MAX_MESSAGE_SIZE,
  DataChannelProtocolMessage,
  HandshakeMessage,
  LLMResponseMessage,
  LLMErrorMessage,
  createHandshake,
  negotiateVersion,
} from "./types/protocol.js";
import { compressSDP, decompressSDP, displayQR, promptForSDP } from "./transport/webrtc-qr.js";

// ── Parse simple CLI args ──
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const localPort = parseInt(getArg("--port", "8080"), 10);
const localHost = getArg("--host", "127.0.0.1");
const requestTimeoutMs = parseInt(getArg("--timeout", "120000"), 10);

interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   WebRTC Client (QR Signaling)       ║");
  console.log("║   LAN-only · No HTTP between peers   ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // ── Step 1: Get server's offer ──
  const compressedOffer = await promptForSDP(
    "  Paste the server's compressed SDP offer"
  );

  let offerSdp: string;
  try {
    offerSdp = decompressSDP(compressedOffer);
    console.log(`[client] ✓ Decoded server offer (${offerSdp.length} bytes)`);
  } catch {
    console.error("[client] ✗ Failed to decode offer. Make sure you pasted the full string.");
    process.exit(1);
  }

  // ── Step 2: Create PeerConnection ──
  let nodeDataChannel: any;
  try {
    nodeDataChannel = await import("node-datachannel");
  } catch {
    console.error("[client] ✗ node-datachannel not available. Install: npm install node-datachannel");
    process.exit(1);
  }

  const NDC = (nodeDataChannel as any).default ?? nodeDataChannel;
  const PeerConnection = NDC.PeerConnection ?? NDC;

  console.log("[client] creating PeerConnection...");

  const pc = new PeerConnection("qr-client", {
    iceServers: [],
    maxMessageSize: DATACHANNEL_MAX_MESSAGE_SIZE,
  });

  // ── Step 3: Set remote offer and create answer ──
  let handshakeComplete = false;
  let negotiatedVersion: number | null = null;
  let dc: any = null;
  const pendingRequests = new Map<string, PendingRequest>();

  // Handle incoming DataChannel from server
  const dcReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("DataChannel open timeout (30s)")), 30_000);

    pc.onDataChannel((incomingDc: any) => {
      console.log(`[client] DataChannel received: ${incomingDc.getLabel()}`);
      if (incomingDc.getLabel() === DATACHANNEL_LABEL) {
        dc = incomingDc;
        clearTimeout(timeout);

        dc.onOpen(() => {
          console.log(`[client] ✓ DataChannel "${DATACHANNEL_LABEL}" opened`);
          // Send handshake
          const hs = createHandshake();
          dc.sendMessage(JSON.stringify(hs));
          console.log("[client] sent handshake");
          resolve();
        });

        dc.onMessage((msgRaw: string | Buffer) => {
          const raw = typeof msgRaw === "string"
            ? msgRaw
            : new TextDecoder().decode(msgRaw as unknown as ArrayBuffer);
          handleMessage(raw);
        });

        dc.onClosed(() => {
          console.log("[client] DataChannel closed");
          rejectAllPending("DataChannel closed");
        });
      }
    });
  });

  pc.onStateChange((state: string) => {
    console.log(`[client] PeerConnection: ${state}`);
    if (state === "failed" || state === "closed") {
      rejectAllPending("PeerConnection " + state);
    }
  });

  // Set the remote offer
  pc.setRemoteDescription(offerSdp, "offer");

  // Wait for ICE gathering on our side
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearTimeout(fallback);
      resolve();
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        const desc = pc.localDescription();
        if (desc?.sdp?.includes("a=candidate")) {
          done();
        } else {
          console.error("[client] ✗ ICE gathering failed");
          process.exit(1);
        }
      }
    }, 15_000);

    pc.onGatheringStateChange((state: string) => {
      console.log(`[client] ICE gathering: ${state}`);
      if (state === "complete") done();
    });

    pc.onLocalCandidate(() => {
      console.log("[client] ICE candidate found");
    });

    const fallback = setTimeout(() => {
      if (!resolved) {
        const desc = pc.localDescription();
        if (desc?.sdp?.includes("a=candidate")) {
          console.log("[client] ICE fallback: have candidates after 2s");
          done();
        }
      }
    }, 2_000);
  });

  // ── Step 4: Get answer and display QR ──
  const answerDesc = pc.localDescription();
  if (!answerDesc?.sdp) {
    console.error("[client] ✗ Failed to generate SDP answer");
    process.exit(1);
  }

  const compressedAnswer = compressSDP(answerDesc.sdp);
  console.log(`[client] SDP answer: ${answerDesc.sdp.length} bytes → ${compressedAnswer.length} chars compressed`);

  await displayQR(compressedAnswer, "CLIENT ANSWER — Scan this QR or paste the string on the server");

  console.log("  Paste the compressed string above into the server terminal.\n");
  console.log("[client] waiting for WebRTC connection...\n");

  // ── Step 5: Wait for DataChannel ──
  try {
    await dcReady;
  } catch (err) {
    console.error(`[client] ✗ ${(err as Error).message}`);
    process.exit(1);
  }

  // Wait for handshake
  await new Promise<void>((resolve, reject) => {
    if (handshakeComplete) { resolve(); return; }
    const timeout = setTimeout(() => reject(new Error("Handshake timeout (15s)")), 15_000);
    const check = setInterval(() => {
      if (handshakeComplete) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);
  });

  console.log(`[client] ✓ WebRTC fully connected!\n`);

  // ── Step 6: Start local HTTP proxy ──
  const app = express();
  app.use(express.json({ limit: "100mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: handshakeComplete ? "ok" : "degraded",
      mode: "client",
      transport: "webrtc-qr",
      webrtcConnected: handshakeComplete,
    });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    try {
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

      if (!handshakeComplete || !dc) {
        res.status(503).json({
          error: {
            message: "WebRTC connection not ready",
            type: "server_error",
          },
        });
        return;
      }

      if (body.stream) {
        body.stream = false;
      }

      const response = await sendLLMRequest(body);
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[client] request error:", message);
      res.status(502).json({
        error: {
          message: `WebRTC proxy error: ${message}`,
          type: "server_error",
        },
      });
    }
  });

  app.get("/v1/models", (_req: Request, res: Response) => {
    res.json({ object: "list", data: [] });
  });

  await new Promise<void>((resolve) => {
    app.listen(localPort, localHost, () => {
      console.log(`[client] ✓ Local OpenAI-compatible API ready:`);
      console.log(`[client]   POST http://${localHost}:${localPort}/v1/chat/completions`);
      console.log(`[client]   GET  http://${localHost}:${localPort}/health`);
      console.log();
      console.log(`[client] Example:`);
      console.log(`  curl http://${localHost}:${localPort}/v1/chat/completions \\`);
      console.log(`    -H "Content-Type: application/json" \\`);
      console.log(`    -d '{"model":"any","messages":[{"role":"user","content":"Hello!"}]}'`);
      console.log();
      resolve();
    });
  });

  // ── Message handling ──

  function handleMessage(raw: string): void {
    let msg: DataChannelProtocolMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[client] invalid JSON on DataChannel");
      return;
    }

    if (msg.schema_version !== 1) return;

    switch (msg.type) {
      case "handshake": {
        const local = createHandshake();
        const version = negotiateVersion(local, msg as HandshakeMessage);
        if (version === null) {
          console.error("[client] ✗ handshake failed: incompatible versions");
          return;
        }
        negotiatedVersion = version;
        handshakeComplete = true;
        console.log(`[client] ✓ handshake complete (version ${version})`);
        break;
      }

      case "llm_response": {
        const respMsg = msg as LLMResponseMessage;
        const pending = pendingRequests.get(respMsg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(respMsg.id);
          pending.resolve(respMsg.payload);
        }
        break;
      }

      case "llm_error": {
        const errMsg = msg as LLMErrorMessage;
        const pending = pendingRequests.get(errMsg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(errMsg.id);
          pending.reject(new Error(`${errMsg.error.code}: ${errMsg.error.message}`));
        }
        break;
      }
    }
  }

  function sendLLMRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = uuidv4();
    const message = JSON.stringify({
      schema_version: 1,
      type: "llm_request",
      id,
      payload,
    });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);

      pendingRequests.set(id, { resolve, reject, timer });

      try {
        dc.sendMessage(message);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  function rejectAllPending(reason: string): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingRequests.clear();
  }

  // Keep alive
  const shutdown = () => {
    console.log("\n[client] shutting down...");
    try { dc?.close(); } catch {}
    try { pc.close(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[client] fatal:", err);
  process.exit(1);
});
