/**
 * IPLD Retrieval Client
 *
 * Implements verified retrieval of conversation data from IPFS/IPLD.
 * Supports decryption, decompression, and DAG traversal.
 *
 * @module client/retrieval
 */

import {
  fetchWithFallback,
  fetchAndVerify,
  traverseVerified,
  VerificationCodec,
  GatewayConfig,
  DEFAULT_GATEWAYS,
} from "../lib/cid-verify";
import { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "../types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DecryptedConversation {
  request: OpenAIChatCompletionRequest;
  response: OpenAIChatCompletionResponse;
  metadata?: {
    encryption?: EncryptionMetadata;
    compression?: CompressionMetadata;
    timestamp: number;
  };
}

export interface EncryptionMetadata {
  version: string;
  encryptedKey: string;
  keyHash: string;
  algorithm: string;
  ivLengthBytes: number;
  accessControlConditions: Record<string, unknown>[];
  chain: string;
}

export interface CompressionMetadata {
  compressed: boolean;
  algorithm: string;
  originalSize?: number;
}

export interface RetrievalOptions {
  /** IPFS gateways to use for fetching */
  gateways?: GatewayConfig[];
  /** Timeout for fetch operations in milliseconds */
  timeoutMs?: number;
  /** Enable verification at each step */
  verify?: boolean;
  /** Codec for parsing content */
  codec?: VerificationCodec;
}

export interface RetrievalContext {
  /** The wallet private key for TACo decryption */
  privateKey?: string;
  /** TACo domain to use */
  tacoDomain?: string;
  /** Chain for access control conditions */
  chain?: string;
}

// ── Decryption Helpers ──────────────────────────────────────────────────────

/**
 * Decrypt data using AES-256-GCM.
 * Layout: [IV (12 bytes)][Ciphertext][Auth Tag (16 bytes)]
 */
async function aesGcmDecrypt(
  encryptedData: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  const crypto = await import("crypto");

  if (encryptedData.length < 28) {
    throw new Error("Encrypted data too short (must include IV + ciphertext + auth tag)");
  }

  // Extract components
  const iv = encryptedData.slice(0, 12);
  const authTag = encryptedData.slice(encryptedData.length - 16);
  const ciphertext = encryptedData.slice(12, encryptedData.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

/**
 * Recover AES key via TACo Protocol.
 */
async function recoverKeyViaTaco(
  metadata: EncryptionMetadata,
  privateKey: string,
  domain: string,
  chain: string
): Promise<Uint8Array> {
  // Dynamic import for TACo SDK
  const tacoModule = await import("@nucypher/taco");
  const { decrypt, initialize, domains } = tacoModule;
  
  const authModule = await import("@nucypher/taco-auth");
  const { EIP4361AuthProvider } = authModule;
  
  const ethersModule = await import("ethers");
  const ethers = (ethersModule as any).ethers || (ethersModule as any).default;

  // Initialize TACo SDK
  await initialize();

  // Create provider
  const provider = new ethers.providers.JsonRpcProvider(
    'https://ethereum-sepolia-rpc.publicnode.com'
  );

  // Create wallet and signer
  const wallet = new ethers.Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
  );
  const signer = wallet.connect(provider);

  // Create auth provider
  const authProvider = new EIP4361AuthProvider(provider, signer);

  // Map domain names
  const domainMap: Record<string, string> = {
    "lynx": "datil-dev",
    "ursula": "datil-test",
    "datil-dev": "datil-dev",
    "datil-test": "datil-test",
    "datil": "datil",
  };
  const networkName = domainMap[domain] || "datil-dev";

  // Decrypt the key using TACo
  // Convert encrypted key from base64 string to ThresholdMessageKit
  const messageKitBytes = Buffer.from(metadata.encryptedKey, 'base64');
  
  // @ts-ignore - nucypher-core types
  const { ThresholdMessageKit } = await import('@nucypher/nucypher-core');
  const messageKit = ThresholdMessageKit.fromBytes(new Uint8Array(messageKitBytes));
  
  // Create ConditionContext for decryption
  // @ts-ignore - dynamic path may not resolve in static analysis
  const contextModule = await import('@nucypher/taco/conditions/context');
  const { ConditionContext } = contextModule;
  
  const conditionProps = {
    contractAddress: (metadata.accessControlConditions[0]?.contractAddress as string)?.toLowerCase() || '',
    standardContractType: 'ERC20',
    chain: metadata.chain,
    method: 'balanceOf',
    parameters: [':userAddress'],
    returnValueTest: {
      comparator: '>=',
      value: '1',
    },
  };
  
  const context = new ConditionContext(authProvider, conditionProps);
  
  const decryptedBytes = await decrypt(
    provider,
    domains.DEVNET,
    messageKit,
    context
  );

  // Verify key hash
  const { createHash } = await import("crypto");
  const keyHash = createHash("sha256").update(decryptedBytes).digest("hex");
  if (keyHash !== metadata.keyHash) {
    throw new Error("Key hash mismatch - recovered key is invalid");
  }

  return decryptedBytes;
}

/**
 * Decompress gzip data.
 */
async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const zlib = await import("zlib");
  const { promisify } = await import("util");
  const gunzip = promisify(zlib.gunzip);
  
  const result = await gunzip(Buffer.from(data));
  return new Uint8Array(result);
}

/**
 * Check if data is gzip compressed (magic number check).
 */
function isGzipCompressed(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

// ── Main Retrieval Functions ────────────────────────────────────────────────

/**
 * Retrieve and decrypt a conversation from IPLD.
 *
 * Flow:
 * 1. Resolve IPNS name if provided (or use direct CID)
 * 2. Fetch and verify the IPLD DAG root
 * 3. Traverse the DAG to retrieve request and response
 * 4. Decrypt content if encrypted
 * 5. Decompress if gzip compressed
 * 6. Parse and return the conversation
 *
 * @param metadataCid - CID of the conversation metadata or root
 * @param decryptionKey - Optional AES key for decryption (if not using Lit)
 * @param options - Retrieval options
 * @param context - Retrieval context with Lit credentials
 * @returns Decrypted conversation
 */
export async function retrieveConversation(
  metadataCid: string,
  decryptionKey?: string,
  options: RetrievalOptions = {},
  context: RetrievalContext = {}
): Promise<DecryptedConversation> {
  const gateways = options.gateways ?? DEFAULT_GATEWAYS;
  const verify = options.verify ?? true;
  const timeoutMs = options.timeoutMs ?? 60000;
  const codec = options.codec ?? "dag-json";

  // Step 1: Fetch the root node
  const rootResult = verify 
    ? await fetchWithFallback(metadataCid, gateways, { codec, timeoutMs })
    : await fetchAndVerify(metadataCid, gateways[0]?.url ?? DEFAULT_GATEWAYS[0].url, { codec, timeoutMs });

  // Step 2: Parse the root node
  const rootData = JSON.parse(new TextDecoder().decode(rootResult.data));

  // Handle different conversation formats
  let encryptedBuffer: Uint8Array | undefined;
  let encryptionMetadata: EncryptionMetadata | undefined;
  let compressionMetadata: CompressionMetadata | undefined;

  if (rootData.encryption?.encrypted) {
    encryptionMetadata = rootData.encryption;
  }

  if (rootData.compression?.compressed) {
    compressionMetadata = rootData.compression;
  }

  // Step 3: Retrieve the encrypted blob if needed
  if (rootData.conversationCid) {
    const convResult = verify
      ? await fetchWithFallback(rootData.conversationCid as string, gateways, { codec: "raw", timeoutMs })
      : await fetchAndVerify(rootData.conversationCid as string, gateways[0]?.url ?? DEFAULT_GATEWAYS[0].url, { codec: "raw", timeoutMs });
    encryptedBuffer = convResult.data;
  } else if (rootData.encryptedData) {
    // Inline encrypted data
    encryptedBuffer = Buffer.from(rootData.encryptedData, "base64");
  } else {
    // Direct JSON content (unencrypted)
    return {
      request: rootData.request,
      response: rootData.response,
      metadata: {
        compression: compressionMetadata,
        timestamp: rootData.timestamp,
      },
    };
  }

  if (!encryptedBuffer) {
    throw new Error("No conversation data found in root node");
  }

  // Step 4: Decrypt if encrypted
  let decryptedData = encryptedBuffer;
  if (encryptionMetadata) {
    let aesKey: Uint8Array;

    if (decryptionKey) {
      // Use provided key
      aesKey = Buffer.from(decryptionKey, "hex");
    } else if (context.privateKey) {
      // Recover key via TACo Protocol
      aesKey = await recoverKeyViaTaco(
        encryptionMetadata,
        context.privateKey,
        context.tacoDomain ?? "lynx",
        context.chain ?? "ethereum"
      );
    } else {
      throw new Error(
        "Decryption key required but not provided. Pass decryptionKey or context.privateKey."
      );
    }

    decryptedData = await aesGcmDecrypt(encryptedBuffer, aesKey);
  }

  // Step 5: Decompress if needed
  let finalData = decryptedData;
  if (compressionMetadata?.compressed || isGzipCompressed(decryptedData)) {
    finalData = await decompressGzip(decryptedData);
  }

  // Step 6: Parse JSON
  const conversation = JSON.parse(new TextDecoder().decode(finalData));

  return {
    request: conversation.request,
    response: conversation.response,
    metadata: {
      encryption: encryptionMetadata,
      compression: compressionMetadata,
      timestamp: rootData.timestamp,
    },
  };
}

/**
 * Retrieve a single message from a conversation by index.
 * Uses IPLD DAG traversal for efficient partial retrieval.
 *
 * @param rootCid - Root CID of the conversation DAG
 * @param messageIndex - Index of the message to retrieve
 * @param options - Retrieval options
 * @returns The message content
 */
export async function retrieveMessage(
  rootCid: string,
  messageIndex: number,
  options: RetrievalOptions = {}
): Promise<unknown> {
  const path = `request/messages/${messageIndex}`;
  const steps = await traverseVerified(rootCid, path, options.gateways);

  const lastStep = steps[steps.length - 1];
  if (!lastStep.verified || !lastStep.data) {
    throw new Error(
      `Failed to retrieve message at index ${messageIndex}: ${lastStep.error ?? "Unknown error"}`
    );
  }

  return JSON.parse(new TextDecoder().decode(lastStep.data));
}

/**
 * List all messages in a conversation without fetching full content.
 *
 * @param rootCid - Root CID of the conversation DAG
 * @param options - Retrieval options
 * @returns Array of message CIDs and basic metadata
 */
export async function listMessages(
  rootCid: string,
  options: RetrievalOptions = {}
): Promise<Array<{ cid: string; role: string; index: number }>> {
  const gateways = options.gateways ?? DEFAULT_GATEWAYS;

  // Fetch root to get message links
  const rootResult = await fetchWithFallback(rootCid, gateways, {
    codec: "dag-json",
    timeoutMs: options.timeoutMs,
  });

  const root = JSON.parse(new TextDecoder().decode(rootResult.data));

  if (!root.request?.messages) {
    throw new Error("Invalid conversation root: no messages array found");
  }

  // If messages are inline
  if (Array.isArray(root.request.messages)) {
    return root.request.messages.map((msg: unknown, index: number) => ({
      cid: rootCid, // Messages are in the root
      role: (msg as { role: string }).role,
      index,
    }));
  }

  // If messages are linked
  if (root.messageLinks && Array.isArray(root.messageLinks)) {
    return root.messageLinks.map((link: { "/": string }, index: number) => ({
      cid: link["/"],
      role: "unknown", // Would need to fetch to determine role
      index,
    }));
  }

  return [];
}

/**
 * Retrieve multiple conversations in parallel with verification.
 *
 * @param metadataCids - Array of conversation metadata CIDs
 * @param options - Retrieval options
 * @param context - Retrieval context
 * @returns Map of CID to conversation (or error)
 */
export async function retrieveConversations(
  metadataCids: string[],
  options: RetrievalOptions = {},
  context: RetrievalContext = {}
): Promise<Map<string, DecryptedConversation | Error>> {
  const results = new Map<string, DecryptedConversation | Error>();

  // Process with limited concurrency
  const concurrency = 3;
  for (let i = 0; i < metadataCids.length; i += concurrency) {
    const batch = metadataCids.slice(i, i + concurrency);
    const batchPromises = batch.map(async (cid) => {
      try {
        const conversation = await retrieveConversation(cid, undefined, options, context);
        results.set(cid, conversation);
      } catch (err) {
        results.set(
          cid,
          err instanceof Error ? err : new Error(String(err))
        );
      }
    });

    await Promise.all(batchPromises);
  }

  return results;
}
