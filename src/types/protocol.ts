/**
 * Protocol message types for DataChannel communication.
 * Uses schema_version, type discriminator, and handshake negotiation.
 */

import * as crypto from "crypto";

// ── Handshake (bidirectional) ──

export interface HandshakeMessage {
  schema_version: 1;
  type: "handshake";
  protocol_version: {
    current: number;
    min_supported: number;
    max_supported: number;
  };
}

// ── LLM Request (client bridge → shim) ──

export interface LLMRequestMessage {
  schema_version: 1;
  type: "llm_request";
  id: string;
  payload: Record<string, unknown>; // OpenAI ChatCompletion request body
}

// ── LLM Response (shim → client bridge) ──

export interface LLMResponseMessage {
  schema_version: 1;
  type: "llm_response";
  id: string;
  payload: Record<string, unknown>; // OpenAI ChatCompletion response body
}

// ── LLM Error (shim → client bridge) ──

export interface LLMErrorMessage {
  schema_version: 1;
  type: "llm_error";
  id: string;
  error: {
    code: string;
    message: string;
  };
}

// ── Union type for all DataChannel messages ──

export type DataChannelProtocolMessage =
  | HandshakeMessage
  | LLMRequestMessage
  | LLMResponseMessage
  | LLMErrorMessage;

// ── DataChannel constants ──

export const DATACHANNEL_LABEL = "llm";
export const DATACHANNEL_ORDERED = true;
export const DATACHANNEL_MAX_RETRANSMITS = 3;
export const DATACHANNEL_MAX_MESSAGE_SIZE = 104_857_600; // 100 MB — vision/multimodal payloads can be large
export const PROTOCOL_VERSION = 1;
export const SIGNALING_PORT = 8081;
export const SIGNALING_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Generate a cryptographically random alphanumeric token.
 * 16-64 chars, [A-Za-z0-9]+
 */
export function generateToken(length: number = 24): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let token = "";
  for (let i = 0; i < length; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

/**
 * Create a standard handshake message.
 */
export function createHandshake(): HandshakeMessage {
  return {
    schema_version: 1,
    type: "handshake",
    protocol_version: {
      current: PROTOCOL_VERSION,
      min_supported: 1,
      max_supported: 1,
    },
  };
}

/**
 * Validate a handshake message and determine negotiated version.
 * Returns the negotiated version or null if incompatible.
 */
export function negotiateVersion(
  local: HandshakeMessage,
  remote: HandshakeMessage
): number | null {
  const lo = Math.max(
    local.protocol_version.min_supported,
    remote.protocol_version.min_supported
  );
  const hi = Math.min(
    local.protocol_version.max_supported,
    remote.protocol_version.max_supported
  );
  if (lo > hi) return null;
  // Pick the highest mutually-supported version
  return hi;
}