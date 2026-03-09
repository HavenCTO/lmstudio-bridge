/**
 * Types and Interfaces for Data Recovery Module
 */

import { CID } from "multiformats/cid";

// ── Conversation Data Types ─────────────────────────────────────────────────

export interface RecoveredMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
}

export interface RecoveredRequest {
  model: string;
  messages: RecoveredMessage[];
  parameters?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stream?: boolean;
  };
}

export interface RecoveredChoice {
  index: number;
  message: RecoveredMessage;
  finish_reason: string;
}

export interface RecoveredResponse {
  id: string;
  model: string;
  choices: RecoveredChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  created: number;
}

export interface RecoveredMetadata {
  shim_version: string;
  capture_timestamp: number;
  encryption?: {
    encrypted: boolean;
    encrypted_symmetric_key?: string;
    access_control_conditions?: string;
  };
  compression?: {
    compressed: boolean;
    algorithm?: string;
    original_size?: number;
  };
}

export interface RecoveredConversation {
  version: string;
  request: RecoveredRequest;
  response: RecoveredResponse;
  metadata: RecoveredMetadata;
  timestamp: number;
  previousConversation?: CID;
}

// ── CAR File Types ──────────────────────────────────────────────────────────

export interface CarBlock {
  cid: CID;
  bytes: Uint8Array;
  data?: unknown;
}

export interface CarFileData {
  rootCid: CID;
  blocks: Map<string, CarBlock>;
  conversation?: RecoveredConversation;
}

// ── Encryption Types ────────────────────────────────────────────────────────

export interface EncryptionMetadata {
  version: "hybrid-v1";
  encryptedKey: string;
  dataToEncryptHash: string;
  algorithm: "AES-GCM";
  keyLength: number;
  ivLengthBytes: number;
  accessControlConditions: AccessControlCondition[];
  chain: string;
}

export interface AccessControlCondition {
  contractAddress?: string;
  standardContractType?: string;
  chain: string;
  method?: string;
  parameters?: string[];
  returnValueTest: {
    comparator: string;
    value: string;
  };
}

// ── Synapse/Filecoin Types ─────────────────────────────────────────────────-

export interface SynapseRetrievalOptions {
  /** RPC URL for Filecoin network */
  rpcUrl?: string;
  /** Private key for authentication (optional, depending on network) */
  privateKey?: string;
  /** Custom IPFS gateway for retrieval */
  ipfsGateway?: string;
}

export interface RetrievalResult {
  /** The root CID of the retrieved data */
  cid: CID;
  /** Raw CAR file bytes */
  carBytes: Uint8Array;
  /** Number of blocks in the CAR */
  blockCount: number;
  /** Total size in bytes */
  totalSize: number;
  /** Timestamp of retrieval */
  retrievedAt: string;
}

// ── Recovery Options ────────────────────────────────────────────────────────

export interface RecoveryOptions {
  /** CID(s) to recover - can be single or multiple */
  cids: string[];
  /** Output directory for recovered data */
  outputDir: string;
  /** IPFS gateway URL for retrieval */
  ipfsGateway?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Skip decryption (keep encrypted data as-is) */
  skipDecryption?: boolean;
  /** TACo domain for decryption */
  tacoDomain?: string;
  /** Ritual ID for TACo decryption */
  ritualId?: number;
  /** Wallet private key for TACo authentication */
  tacoPrivateKey?: string;
  /** RPC URL for blockchain interaction */
  rpcUrl?: string;
}

export interface DecryptionResult {
  /** Whether decryption was successful */
  success: boolean;
  /** Decrypted data buffer (if successful) */
  decryptedBuffer?: Buffer;
  /** Error message (if failed) */
  error?: string;
  /** Original encrypted buffer */
  encryptedBuffer?: Buffer;
}

// ── CLI Command Types ───────────────────────────────────────────────────────

export interface ListResult {
  cid: string;
  timestamp: string;
  size: number;
  dealId?: string;
  deduplicated: boolean;
}
