/**
 * Types and Interfaces for Data Recovery Module — V2 Architecture
 *
 * Aligned with the v2 archival format: flat dag-cbor conversation blocks
 * inside standard CARv1 files with batch root provenance chain.
 */

import { CID } from "multiformats/cid";

// ── V2 Conversation Data Types (matches ArchiveConversation) ────────────────

export interface RecoveredMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
  name?: string;
}

export interface RecoveredRequest {
  messages: RecoveredMessage[];
  parameters?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stream?: boolean;
    [key: string]: unknown;
  };
}

export interface RecoveredChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

export interface RecoveredResponse {
  id: string;
  model: string;
  created: number;
  choices: RecoveredChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * A recovered conversation — matches the v2 ArchiveConversation structure.
 * Each conversation is a single flat dag-cbor block in the CAR file.
 */
export interface RecoveredConversation {
  id: string;                          // requestId
  timestamp: number;
  model: string;
  request: RecoveredRequest;
  response: RecoveredResponse;
  encrypted?: boolean;
  encryptedPayload?: Uint8Array;
}

// ── V2 Batch Root (matches BatchRoot) ───────────────────────────────────────

export interface RecoveredBatchRoot {
  version: string;
  schemaVersion: string;
  batchId: number;
  timestamp: number;
  previousBatch: CID | null;
  conversations: CID[];
  conversationCount: number;
  metadata: {
    shimVersion: string;
    captureWindow: {
      start: number;
      end: number;
    };
    totalTokens: number;
    models: string[];
  };
}

// ── CAR File Types ──────────────────────────────────────────────────────────

export interface CarBlock {
  cid: CID;
  bytes: Uint8Array;
}

export interface CarFileData {
  rootCid: CID;
  blocks: Map<string, CarBlock>;
}

/**
 * Result of extracting a v2 batch CAR file.
 * Contains the batch root and all conversation blocks.
 */
export interface BatchExtractionResult {
  batchRoot: RecoveredBatchRoot;
  rootCid: CID;
  conversations: Map<string, RecoveredConversation>;  // CID string → conversation
  blockCount: number;
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

// ── Synapse/Filecoin Types ──────────────────────────────────────────────────

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
