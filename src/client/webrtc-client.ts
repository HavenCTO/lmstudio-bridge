/**
 * WebRTC client – creates the PeerConnection and DataChannel.
 *
 *   - Creates PeerConnection with DataChannel("llm", ordered=true, maxRetransmits=3)
 *   - Waits for ICE gathering to complete (bundled ICE, no trickle)
 *   - Provides the SDP offer for the signaling server
 *   - Accepts the SDP answer from the shim
 *   - Manages handshake and message routing
 */

import { v4 as uuidv4 } from "uuid";
import {
  DATACHANNEL_LABEL,
  DATACHANNEL_ORDERED,
  DATACHANNEL_MAX_RETRANSMITS,
  DATACHANNEL_MAX_MESSAGE_SIZE,
  DataChannelProtocolMessage,
  HandshakeMessage,
  LLMResponseMessage,
  LLMErrorMessage,
  createHandshake,
  negotiateVersion,
} from "./protocol.js";

export interface WebRTCClientEvents {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onHandshakeComplete?: (version: number) => void;
  onHandshakeFailed?: (reason: string) => void;
}

export interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class WebRTCClient {
  private pc: any = null;
  private dc: any = null;
  private handshakeComplete = false;
  private negotiatedVersion: number | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private events: WebRTCClientEvents;
  private requestTimeoutMs: number;

  constructor(events: WebRTCClientEvents = {}, requestTimeoutMs: number = 120_000) {
    this.events = events;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Initialize PeerConnection and DataChannel, gather ICE candidates,
   * and return the SDP offer.
   */
  async createOffer(): Promise<string> {
    const nodeDataChannel = await import("node-datachannel");
    // Handle both CJS default export and ESM named export
    const NDC = (nodeDataChannel as any).default ?? nodeDataChannel;
    const PeerConnection = NDC.PeerConnection ?? NDC;

    // Create PeerConnection (local network only, no STUN/TURN)
    this.pc = new PeerConnection("client-bridge", {
      iceServers: [],
    });

    // Create DataChannel
    this.dc = this.pc.createDataChannel(DATACHANNEL_LABEL, {
      ordered: DATACHANNEL_ORDERED,
      maxRetransmits: DATACHANNEL_MAX_RETRANSMITS,
    });

    // Set up DataChannel message handler
    this.dc.onMessage((msgRaw: string | Buffer) => {
      const raw =
        typeof msgRaw === "string"
          ? msgRaw
          : new TextDecoder().decode(msgRaw as unknown as ArrayBuffer);
      this.handleMessage(raw);
    });

    this.dc.onOpen(() => {
      console.log(`[webrtc-client] DataChannel "${DATACHANNEL_LABEL}" opened`);
      // Send handshake immediately
      const handshake = createHandshake();
      this.dc.sendMessage(JSON.stringify(handshake));
      console.log(`[webrtc-client] sent handshake`);
    });

    this.dc.onClosed(() => {
      console.log(`[webrtc-client] DataChannel closed`);
      this.handshakeComplete = false;
      this.rejectAllPending("DataChannel closed");
      this.events.onDisconnected?.();
    });

    // Monitor PeerConnection state
    this.pc.onStateChange((state: string) => {
      console.log(`[webrtc-client] PeerConnection state: ${state}`);
      if (state === "connected") {
        this.events.onConnected?.();
      } else if (
        state === "closed" ||
        state === "failed" ||
        state === "disconnected"
      ) {
        this.handshakeComplete = false;
        this.rejectAllPending("PeerConnection " + state);
        this.events.onDisconnected?.();
      }
    });

    // Wait for ICE gathering to complete (bundled ICE, no trickle)
    await this.waitForIceGatheringComplete();

    // Get the local description (offer with bundled ICE candidates)
    const desc = this.pc.localDescription();
    if (!desc || !desc.sdp) {
      throw new Error("Failed to create SDP offer");
    }

    console.log(`[webrtc-client] SDP offer created with bundled ICE candidates`);
    return desc.sdp;
  }

  /**
   * Set the remote SDP answer from the shim.
   */
  setAnswer(answerSdp: string): void {
    if (!this.pc) {
      throw new Error("PeerConnection not initialized");
    }
    this.pc.setRemoteDescription(answerSdp, "answer" as any);
    console.log(`[webrtc-client] remote answer set`);
  }

  /**
   * Send an LLM request over the DataChannel and wait for the response.
   * Returns a promise that resolves with the OpenAI-compatible response.
   */
  sendRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.handshakeComplete) {
      return Promise.reject(new Error("Handshake not complete"));
    }

    if (!this.dc) {
      return Promise.reject(new Error("DataChannel not available"));
    }

    const id = uuidv4();

    const message = JSON.stringify({
      schema_version: 1,
      type: "llm_request",
      id,
      payload,
    });

    // Validate message size
    if (Buffer.byteLength(message, "utf-8") > DATACHANNEL_MAX_MESSAGE_SIZE) {
      return Promise.reject(new Error("Request exceeds 16KB DataChannel message limit"));
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LLM request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.dc.sendMessage(message);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Check if the client is connected and handshake is complete.
   */
  isReady(): boolean {
    return this.handshakeComplete;
  }

  /**
   * Close the connection.
   */
  close(): void {
    this.rejectAllPending("Connection closing");
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
    }
    this.dc = null;
    this.pc = null;
    this.handshakeComplete = false;
  }

  // ── Private methods ──

  private async waitForIceGatheringComplete(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        clearTimeout(fallback);
        resolve();
      };

      const timeout = setTimeout(() => {
        if (resolved) return;
        // If we have a local description with candidates, consider it done
        const desc = this.pc.localDescription();
        if (desc && desc.sdp && desc.sdp.includes("a=candidate")) {
          console.log(`[webrtc-client] ICE gathering timeout but have candidates, proceeding`);
          done();
          return;
        }
        reject(new Error("ICE gathering timeout (15s)"));
      }, 15_000);

      // Primary: listen for gathering state change
      this.pc.onGatheringStateChange((state: string) => {
        console.log(`[webrtc-client] ICE gathering state: ${state}`);
        if (state === "complete") {
          done();
        }
      });

      // Secondary: listen for local candidates - once we have a host candidate
      // for a local-only connection (no STUN/TURN), that's sufficient
      let candidateCount = 0;
      this.pc.onLocalCandidate((candidate: string, mid: string) => {
        candidateCount++;
        console.log(`[webrtc-client] ICE candidate #${candidateCount}: ${candidate.substring(0, 80)}...`);
      });

      // Fallback: after 2 seconds, if we have any candidates, proceed
      // node-datachannel sometimes doesn't fire "complete" for local-only
      const fallback = setTimeout(() => {
        if (resolved) return;
        const desc = this.pc.localDescription();
        if (desc && desc.sdp && desc.sdp.includes("a=candidate")) {
          console.log(`[webrtc-client] ICE fallback: have candidates after 2s, proceeding`);
          done();
        }
      }, 2_000);
    });
  }

  private handleMessage(raw: string): void {
    let msg: DataChannelProtocolMessage;
    try {
      msg = JSON.parse(raw) as DataChannelProtocolMessage;
    } catch {
      console.error(`[webrtc-client] received invalid JSON on DataChannel`);
      return;
    }

    if (msg.schema_version !== 1) {
      console.error(`[webrtc-client] unsupported schema_version: ${msg.schema_version}`);
      return;
    }

    switch (msg.type) {
      case "handshake":
        this.handleHandshake(msg as HandshakeMessage);
        break;

      case "llm_response":
        this.handleLLMResponse(msg as LLMResponseMessage);
        break;

      case "llm_error":
        this.handleLLMError(msg as LLMErrorMessage);
        break;

      default:
        console.warn(`[webrtc-client] unexpected message type: ${msg.type}`);
    }
  }

  private handleHandshake(remote: HandshakeMessage): void {
    const local = createHandshake();
    const version = negotiateVersion(local, remote);

    if (version === null) {
      const reason = `Incompatible versions (local: ${local.protocol_version.min_supported}-${local.protocol_version.max_supported}, remote: ${remote.protocol_version.min_supported}-${remote.protocol_version.max_supported})`;
      console.error(`[webrtc-client] handshake failed: ${reason}`);
      this.events.onHandshakeFailed?.(reason);
      return;
    }

    this.negotiatedVersion = version;
    this.handshakeComplete = true;
    console.log(`[webrtc-client] handshake complete, negotiated version: ${version}`);
    this.events.onHandshakeComplete?.(version);
  }

  private handleLLMResponse(msg: LLMResponseMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      console.warn(`[webrtc-client] received response for unknown request: ${msg.id}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.resolve(msg.payload);
  }

  private handleLLMError(msg: LLMErrorMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      console.warn(`[webrtc-client] received error for unknown request: ${msg.id}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);
    pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
