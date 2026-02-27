/**
 * WebRTC transport for the LLM Shim.
 *
 * Architecture:
 *   - The shim acts as the "bridge" role: it connects TO a client bridge's
 *     ephemeral signaling server.
 *   - The client bridge (separate process) runs a temporary HTTP server
 *     with GET /offer and POST /answer endpoints.
 *   - After pairing, LLM requests flow over the WebRTC DataChannel.
 *
 * Signaling flow:
 *   1. Client bridge starts ephemeral HTTP signaling server
 *   2. Client bridge creates PeerConnection + DataChannel("llm"), gathers ICE
 *   3. Shim receives pairing info (ip, port, token) via /pair HTTP endpoint
 *   4. Shim fetches SDP offer from client bridge (GET /offer)
 *   5. Shim creates PeerConnection, sets remote description, creates answer
 *   6. Shim submits answer to client bridge (POST /answer)
 *   7. WebRTC DataChannel opens
 *   8. Handshake messages exchanged
 *   9. LLM requests/responses flow over DataChannel
 *
 * Requires: node-datachannel (npm install node-datachannel)
 */

import express, { Request, Response } from "express";
import { Engine } from "../pipeline/engine";
import { OpenAIChatCompletionRequest } from "../types";
import {
  DATACHANNEL_LABEL,
  DATACHANNEL_MAX_MESSAGE_SIZE,
  DataChannelProtocolMessage,
  HandshakeMessage,
  LLMRequestMessage,
  createHandshake,
  negotiateVersion,
  generateToken,
} from "../types/protocol";

export interface WebRTCTransportOptions {
  /** Port for the shim's control HTTP server (receives /pair requests) */
  port: number;
  host: string;
}

const DEFAULTS: WebRTCTransportOptions = {
  port: 8081,
  host: "0.0.0.0",
};

/** State of the WebRTC connection */
type ConnectionState =
  | "waiting"       // No pairing attempt yet
  | "connecting"    // Pairing in progress
  | "connected"     // DataChannel open, handshake done
  | "reconnecting"  // Attempting reconnection
  | "awaiting_repair"; // Reconnection exhausted

interface PeerState {
  pc: any; // PeerConnection instance
  dc: any; // DataChannel reference (received via onDataChannel)
  pairingInfo: { ip: string; port: number; token: string };
  handshakeComplete: boolean;
  negotiatedVersion: number | null;
}

export function createWebRTCTransport(
  engine: Engine,
  options?: Partial<WebRTCTransportOptions>
): { start: () => Promise<void> } {
  const opts = { ...DEFAULTS, ...options };

  const start = async (): Promise<void> => {
    // Dynamic import for node-datachannel
    let nodeDataChannel: typeof import("node-datachannel");
    try {
      nodeDataChannel = await import("node-datachannel");
    } catch {
      console.error(
        "[webrtc-shim] node-datachannel not available. Install with: npm install node-datachannel"
      );
      console.error("[webrtc-shim] WebRTC transport disabled");
      return;
    }

    const PeerConnection = (nodeDataChannel as unknown as { PeerConnection: unknown }).PeerConnection;

    let state: ConnectionState = "waiting";
    let peer: PeerState | null = null;
    let pairingInProgress = false;

    const app = express();
    app.use(express.json({ limit: "1mb" }));

    // ── POST /pair – receive pairing info and connect to client bridge ──
    app.post("/pair", async (req: Request, res: Response) => {
      if (pairingInProgress) {
        res.status(409).json({
          error: true,
          code: "PAIR_IN_PROGRESS",
          message: "A pairing attempt is already underway",
          details: {},
        });
        return;
      }

      const { ip, port, token } = req.body as {
        ip?: string;
        port?: number;
        token?: string;
      };

      // Validate pairing payload
      if (!ip || !port || !token) {
        res.status(400).json({
          error: true,
          code: "INVALID_PAYLOAD",
          message: "Missing required fields: ip, port, token",
          details: {},
        });
        return;
      }

      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        res.status(400).json({
          error: true,
          code: "INVALID_PAYLOAD",
          message: "Invalid IP address format",
          details: { field: "ip" },
        });
        return;
      }

      if (port < 1 || port > 65535) {
        res.status(400).json({
          error: true,
          code: "INVALID_PAYLOAD",
          message: "Port must be between 1 and 65535",
          details: { field: "port" },
        });
        return;
      }

      if (token.length < 16 || token.length > 64 || !/^[A-Za-z0-9]+$/.test(token)) {
        res.status(400).json({
          error: true,
          code: "INVALID_PAYLOAD",
          message: "Token must be 16-64 alphanumeric characters",
          details: { field: "token" },
        });
        return;
      }

      pairingInProgress = true;
      state = "connecting";
      console.log(`[webrtc-shim] pairing with client bridge at ${ip}:${port}`);

      try {
        // Step 1: Fetch SDP offer from client bridge (with retries)
        const offerSdp = await fetchOfferWithRetry(ip, port, token);
        console.log(`[webrtc-shim] received SDP offer from client bridge`);

        // Step 2: Create PeerConnection (local network only, no STUN/TURN)
        type PCType = { 
          setRemoteDescription: (sdp: string, type: string) => void;
          localDescription: () => { sdp: string; type: string } | null;
          createDataChannel: (label: string) => {
            onMessage: (cb: (msg: string) => void) => void;
            sendMessage: (msg: string) => void;
          };
          onDataChannel: (cb: (dc: unknown) => void) => void;
          onStateChange: (cb: (state: string) => void) => void;
        };
        const pc = new (PeerConnection as unknown as new (name: string, opts: unknown) => PCType)("shim", {
          iceServers: [],
        });

        // Step 3: Set remote description (the offer)
        pc.setRemoteDescription(offerSdp, "offer" as any);

        // Step 4: Create answer
        const answer = pc.localDescription();
        if (!answer || !answer.sdp) {
          throw new Error("Failed to create SDP answer");
        }

        // Step 5: Handle incoming DataChannel
        const dcPromise = new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("DataChannel open timeout (30s)"));
          }, 30_000);

          pc.onDataChannel((dc: any) => {
            console.log(`[webrtc-shim] DataChannel received: ${dc.getLabel()}`);
            if (dc.getLabel() === DATACHANNEL_LABEL) {
              clearTimeout(timeout);
              resolve(dc);
            }
          });
        });

        // Step 6: Submit answer to client bridge
        await submitAnswer(ip, port, token, answer.sdp);
        console.log(`[webrtc-shim] submitted SDP answer to client bridge`);

        // Step 7: Wait for DataChannel to open
        const dc = await dcPromise;
        console.log(`[webrtc-shim] DataChannel "${DATACHANNEL_LABEL}" open`);

        // Store peer state
        peer = {
          pc,
          dc,
          pairingInfo: { ip, port, token },
          handshakeComplete: false,
          negotiatedVersion: null,
        };

        // Step 8: Send handshake
        const localHandshake = createHandshake();
        dc.sendMessage(JSON.stringify(localHandshake));
        console.log(`[webrtc-shim] sent handshake`);

        // Step 9: Set up message handler
        dc.onMessage((msgRaw: string | Buffer) => {
          const raw =
            typeof msgRaw === "string"
              ? msgRaw
              : new TextDecoder().decode(msgRaw as unknown as ArrayBuffer);

          handleMessage(engine, peer!, raw, (response: string) => {
            try {
              if (Buffer.byteLength(response, "utf-8") > DATACHANNEL_MAX_MESSAGE_SIZE) {
                console.error(`[webrtc-shim] response exceeds 16KB limit, dropping`);
                return;
              }
              dc.sendMessage(response);
            } catch (err) {
              console.error(`[webrtc-shim] failed to send response:`, err);
            }
          });
        });

        // Handle connection state changes
        pc.onStateChange((pcState: string) => {
          console.log(`[webrtc-shim] PeerConnection state: ${pcState}`);
          if (pcState === "closed" || pcState === "failed" || pcState === "disconnected") {
            state = "awaiting_repair";
            peer = null;
            console.log(`[webrtc-shim] connection lost, awaiting re-pair`);
          }
        });

        state = "connected";
        pairingInProgress = false;

        res.json({
          paired: true,
          reason: `Connected to client bridge at ${ip}:${port}`,
        });
      } catch (err) {
        pairingInProgress = false;
        state = "awaiting_repair";
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[webrtc-shim] pairing failed:`, message);
        res.status(500).json({
          error: true,
          code: "PAIR_FAILED",
          message: "Pairing could not be completed",
          details: { reason: message },
        });
      }
    });

    // ── GET /status – connection health ──
    app.get("/status", async (_req: Request, res: Response) => {
      const lmsOk = await engine.healthCheck();
      res.json({
        connected: state === "connected",
        state,
        lmstudio: lmsOk ? "reachable" : "unreachable",
        handshakeComplete: peer?.handshakeComplete ?? false,
        negotiatedVersion: peer?.negotiatedVersion ?? null,
      });
    });

    // ── GET /health ──
    app.get("/health", async (_req: Request, res: Response) => {
      const lmsOk = await engine.healthCheck();
      res.json({
        status: lmsOk && state === "connected" ? "ok" : "degraded",
        transport: "webrtc",
        connectionState: state,
        lmstudio: lmsOk ? "reachable" : "unreachable",
      });
    });

    return new Promise<void>((resolve) => {
      app.listen(opts.port, opts.host, () => {
        console.log(
          `[webrtc-shim] control server on http://${opts.host}:${opts.port}`
        );
        console.log(`[webrtc-shim] POST /pair to connect to a client bridge`);
        console.log(`[webrtc-shim] GET /status for connection health`);
        resolve();
      });
    });
  };

  return { start };
}

/**
 * Fetch SDP offer from the client bridge's signaling server.
 * Retries on 503 (ICE not ready) and transient errors.
 */
async function fetchOfferWithRetry(
  ip: string,
  port: number,
  token: string,
  maxAttempts: number = 5
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`http://${ip}:${port}/offer`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (response.status === 200) {
        const body = (await response.json()) as { offer: string };
        return body.offer;
      } else if (response.status === 503) {
        // ICE gathering not complete, retry after 1 second
        console.log(
          `[webrtc-shim] signaling server not ready (503), retrying in 1s (attempt ${attempt + 1}/${maxAttempts})`
        );
        await sleep(1000);
        continue;
      } else if (response.status === 401) {
        throw new Error("Unauthorized: bearer token mismatch");
      } else {
        throw new Error(`Unexpected status from signaling server: ${response.status}`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Unauthorized")) {
        throw err; // Don't retry auth failures
      }
      if (attempt < maxAttempts - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s
        console.log(
          `[webrtc-shim] fetch offer failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
        await sleep(delay);
      } else {
        throw new Error(
          `Failed to fetch offer after ${maxAttempts} attempts: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }
  throw new Error("Failed to fetch offer: max attempts exceeded");
}

/**
 * Submit SDP answer to the client bridge's signaling server.
 */
async function submitAnswer(
  ip: string,
  port: number,
  token: string,
  answerSdp: string
): Promise<void> {
  const response = await fetch(`http://${ip}:${port}/answer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ answer: answerSdp }),
    signal: AbortSignal.timeout(5000),
  });

  if (response.status === 200) {
    return;
  } else if (response.status === 401) {
    throw new Error("Unauthorized: bearer token mismatch");
  } else if (response.status === 409) {
    throw new Error("Answer already submitted (409 Conflict) – possible attack or race");
  } else {
    const body = await response.text();
    throw new Error(`Failed to submit answer: ${response.status} ${body}`);
  }
}

/**
 * Handle a message received on the DataChannel.
 */
function handleMessage(
  engine: Engine,
  peer: PeerState,
  raw: string,
  send: (msg: string) => void
): void {
  let msg: DataChannelProtocolMessage;
  try {
    msg = JSON.parse(raw) as DataChannelProtocolMessage;
  } catch {
    console.error(`[webrtc-shim] received invalid JSON on DataChannel`);
    return;
  }

  // Validate schema_version
  if (msg.schema_version !== 1) {
    console.error(`[webrtc-shim] unsupported schema_version: ${msg.schema_version}`);
    return;
  }

  switch (msg.type) {
    case "handshake":
      handleHandshake(peer, msg as HandshakeMessage, send);
      break;

    case "llm_request":
      handleLLMRequest(engine, peer, msg as LLMRequestMessage, send);
      break;

    default:
      console.warn(`[webrtc-shim] unexpected message type: ${msg.type}`);
  }
}

/**
 * Process handshake from the client bridge.
 */
function handleHandshake(
  peer: PeerState,
  remote: HandshakeMessage,
  _send: (msg: string) => void
): void {
  const local = createHandshake();
  const version = negotiateVersion(local, remote);

  if (version === null) {
    console.error(
      `[webrtc-shim] handshake failed: incompatible versions (local: ${local.protocol_version.min_supported}-${local.protocol_version.max_supported}, remote: ${remote.protocol_version.min_supported}-${remote.protocol_version.max_supported})`
    );
    return;
  }

  peer.negotiatedVersion = version;
  peer.handshakeComplete = true;
  console.log(`[webrtc-shim] handshake complete, negotiated version: ${version}`);
}

/**
 * Process an LLM request from the client bridge.
 */
async function handleLLMRequest(
  engine: Engine,
  peer: PeerState,
  msg: LLMRequestMessage,
  send: (msg: string) => void
): Promise<void> {
  if (!peer.handshakeComplete) {
    send(
      JSON.stringify({
        schema_version: 1,
        type: "llm_error",
        id: msg.id,
        error: {
          code: "HANDSHAKE_REQUIRED",
          message: "Handshake must complete before sending requests",
        },
      })
    );
    return;
  }

  try {
    const req = msg.payload as unknown as OpenAIChatCompletionRequest;

    if (!req.model || !req.messages) {
      send(
        JSON.stringify({
          schema_version: 1,
          type: "llm_error",
          id: msg.id,
          error: {
            code: "INVALID_REQUEST",
            message: "Missing required fields: model, messages",
          },
        })
      );
      return;
    }

    // Force non-streaming for DataChannel
    req.stream = false;

    const response = await engine.handleChatCompletion(req);

    send(
      JSON.stringify({
        schema_version: 1,
        type: "llm_response",
        id: msg.id,
        payload: response,
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[webrtc-shim] error processing LLM request ${msg.id}:`, err);
    send(
      JSON.stringify({
        schema_version: 1,
        type: "llm_error",
        id: msg.id,
        error: {
          code: "PROXY_ERROR",
          message: `LM Studio proxy error: ${message}`,
        },
      })
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}