#!/usr/bin/env node
/**
 * WebRTC Server with QR-code signaling (no HTTP between machines).
 *
 * This computer has LM Studio. It generates a WebRTC offer,
 * displays it as a QR code, and waits for the client's answer.
 *
 * Usage:
 *   node dist/qr-server.js [--lmstudio-url http://localhost:1234] [--port 8081]
 *
 * Flow:
 *   1. Creates PeerConnection + DataChannel
 *   2. Generates SDP offer → compresses → displays QR code
 *   3. Waits for you to paste the client's compressed SDP answer
 *   4. WebRTC DataChannel connects
 *   5. LLM requests flow over DataChannel
 */

import { Engine } from "./pipeline/engine.js";
import { loggerMiddleware } from "./middleware/logger.js";
import {
  DATACHANNEL_LABEL,
  DATACHANNEL_MAX_MESSAGE_SIZE,
  DataChannelProtocolMessage,
  HandshakeMessage,
  LLMRequestMessage,
  createHandshake,
  negotiateVersion,
} from "./types/protocol.js";
import { OpenAIChatCompletionRequest } from "./types/index.js";
import { compressSDP, decompressSDP, displayQR, promptForSDP } from "./transport/webrtc-qr.js";

// ── Parse simple CLI args ──
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const lmstudioUrl = getArg("--lmstudio-url", "http://localhost:1234");

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   WebRTC Server (QR Signaling)       ║");
  console.log("║   LAN-only · No HTTP between peers   ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // ── Step 1: Set up LLM engine ──
  const engine = new Engine({
    lmstudio: {
      baseUrl: lmstudioUrl,
      timeoutMs: 0,
    },
  });
  engine.use(loggerMiddleware);

  const lmsOk = await engine.healthCheck();
  if (lmsOk) {
    console.log(`[server] ✓ LM Studio reachable at ${lmstudioUrl}`);
  } else {
    console.warn(`[server] ⚠ LM Studio not reachable at ${lmstudioUrl}`);
  }

  // ── Step 2: Create PeerConnection ──
  let nodeDataChannel: any;
  try {
    nodeDataChannel = await import("node-datachannel");
  } catch {
    console.error("[server] ✗ node-datachannel not available. Install: npm install node-datachannel");
    process.exit(1);
  }

  const NDC = (nodeDataChannel as any).default ?? nodeDataChannel;
  const PeerConnection = NDC.PeerConnection ?? NDC;

  console.log("[server] creating PeerConnection...");

  const pc = new PeerConnection("qr-server", {
    iceServers: [],
  });

  // Create DataChannel (server creates it, client receives it)
  const dc = pc.createDataChannel(DATACHANNEL_LABEL, {
    ordered: true,
    maxRetransmits: 3,
  });

  // ── Step 3: Wait for ICE gathering ──
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
          console.log("[server] ICE timeout but have candidates, proceeding");
          done();
        } else {
          console.error("[server] ✗ ICE gathering failed - no candidates");
          process.exit(1);
        }
      }
    }, 15_000);

    pc.onGatheringStateChange((state: string) => {
      console.log(`[server] ICE gathering: ${state}`);
      if (state === "complete") done();
    });

    pc.onLocalCandidate((candidate: string) => {
      console.log(`[server] ICE candidate found`);
    });

    const fallback = setTimeout(() => {
      if (!resolved) {
        const desc = pc.localDescription();
        if (desc?.sdp?.includes("a=candidate")) {
          console.log("[server] ICE fallback: have candidates after 2s");
          done();
        }
      }
    }, 2_000);
  });

  // ── Step 4: Get offer and display QR ──
  const desc = pc.localDescription();
  if (!desc?.sdp) {
    console.error("[server] ✗ Failed to generate SDP offer");
    process.exit(1);
  }

  const compressedOffer = compressSDP(desc.sdp);
  console.log(`[server] SDP offer: ${desc.sdp.length} bytes → ${compressedOffer.length} chars compressed`);

  await displayQR(compressedOffer, "SERVER OFFER — Scan this QR code on the client machine");

  console.log("  On the client machine, run:");
  console.log("    node dist/qr-client.js");
  console.log("  Then paste the compressed string above when prompted.\n");

  // ── Step 5: Wait for client's answer ──
  const compressedAnswer = await promptForSDP(
    "\n  Paste the client's compressed SDP answer here"
  );

  let answerSdp: string;
  try {
    answerSdp = decompressSDP(compressedAnswer);
    console.log(`[server] ✓ Decoded client answer (${answerSdp.length} bytes)`);
  } catch (err) {
    console.error("[server] ✗ Failed to decode answer. Make sure you pasted the full string.");
    process.exit(1);
  }

  // ── Step 6: Set remote answer ──
  pc.setRemoteDescription(answerSdp, "answer");
  console.log("[server] remote answer set, waiting for DataChannel...");

  // ── Step 7: Set up DataChannel handlers ──
  let handshakeComplete = false;
  let negotiatedVersion: number | null = null;

  const dcReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("DataChannel open timeout (30s)")), 30_000);

    dc.onOpen(() => {
      console.log(`[server] ✓ DataChannel "${DATACHANNEL_LABEL}" opened`);
      clearTimeout(timeout);

      // Send handshake
      const hs = createHandshake();
      dc.sendMessage(JSON.stringify(hs));
      console.log("[server] sent handshake");
      resolve();
    });

    dc.onClosed(() => {
      console.log("[server] DataChannel closed");
    });
  });

  dc.onMessage((msgRaw: string | Buffer) => {
    const raw = typeof msgRaw === "string"
      ? msgRaw
      : new TextDecoder().decode(msgRaw as unknown as ArrayBuffer);

    let msg: DataChannelProtocolMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[server] invalid JSON on DataChannel");
      return;
    }

    if (msg.schema_version !== 1) return;

    switch (msg.type) {
      case "handshake": {
        const local = createHandshake();
        const version = negotiateVersion(local, msg as HandshakeMessage);
        if (version === null) {
          console.error("[server] ✗ handshake failed: incompatible versions");
          return;
        }
        negotiatedVersion = version;
        handshakeComplete = true;
        console.log(`[server] ✓ handshake complete (version ${version})`);
        console.log("[server] ✓ Ready for LLM requests!\n");
        break;
      }

      case "llm_request": {
        if (!handshakeComplete) {
          dc.sendMessage(JSON.stringify({
            schema_version: 1,
            type: "llm_error",
            id: (msg as LLMRequestMessage).id,
            error: { code: "HANDSHAKE_REQUIRED", message: "Handshake not complete" },
          }));
          return;
        }

        const reqMsg = msg as LLMRequestMessage;
        const req = reqMsg.payload as unknown as OpenAIChatCompletionRequest;
        req.stream = false;

        console.log(`[server] LLM request ${reqMsg.id} (model: ${req.model})`);

        engine.handleChatCompletion(req).then((response) => {
          const responseStr = JSON.stringify({
            schema_version: 1,
            type: "llm_response",
            id: reqMsg.id,
            payload: response,
          });

          if (Buffer.byteLength(responseStr, "utf-8") > DATACHANNEL_MAX_MESSAGE_SIZE) {
            console.error(`[server] response exceeds 16KB, dropping`);
            dc.sendMessage(JSON.stringify({
              schema_version: 1,
              type: "llm_error",
              id: reqMsg.id,
              error: { code: "RESPONSE_TOO_LARGE", message: "Response exceeds DataChannel limit" },
            }));
            return;
          }

          dc.sendMessage(responseStr);
          console.log(`[server] sent response for ${reqMsg.id}`);
        }).catch((err: Error) => {
          console.error(`[server] LLM error:`, err.message);
          dc.sendMessage(JSON.stringify({
            schema_version: 1,
            type: "llm_error",
            id: reqMsg.id,
            error: { code: "PROXY_ERROR", message: err.message },
          }));
        });
        break;
      }
    }
  });

  pc.onStateChange((state: string) => {
    console.log(`[server] PeerConnection: ${state}`);
    if (state === "failed" || state === "closed") {
      console.log("[server] connection lost");
    }
  });

  try {
    await dcReady;
  } catch (err) {
    console.error(`[server] ✗ ${(err as Error).message}`);
    process.exit(1);
  }

  // Keep alive
  console.log("[server] server running. Press Ctrl+C to stop.\n");

  const shutdown = () => {
    console.log("\n[server] shutting down...");
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
