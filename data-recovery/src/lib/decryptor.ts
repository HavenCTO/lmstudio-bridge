/**
 * TACo Decryption Module
 *
 * Handles decryption of data encrypted with TACo (Threshold Access Control)
 * from the Nucypher network. Supports both hybrid encryption (AES-GCM + TACo)
 * and direct TACo encryption.
 */

import * as crypto from "crypto";
import { EncryptionMetadata, AccessControlCondition, DecryptionResult } from "../types";

// ── AES-256-GCM Decryption Helpers ──────────────────────────────────────────

const AES_KEY_BYTES = 32; // 256 bits
const AES_IV_BYTES = 12;  // 96-bit nonce
const AES_TAG_BYTES = 16; // 128-bit auth tag

/**
 * Decrypt AES-GCM encrypted data
 */
export function aesDecrypt(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer
): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  
  // Extract auth tag (last 16 bytes)
  const authTag = ciphertext.slice(ciphertext.length - AES_TAG_BYTES);
  const encryptedData = ciphertext.slice(AES_IV_BYTES, ciphertext.length - AES_TAG_BYTES);
  
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  
  return decrypted;
}

/**
 * Parse encrypted buffer into IV, ciphertext, and auth tag
 */
export function parseEncryptedBuffer(buffer: Buffer): {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
} {
  if (buffer.length < AES_IV_BYTES + AES_TAG_BYTES) {
    throw new Error(
      `Encrypted buffer too short: ${buffer.length} bytes (minimum: ${AES_IV_BYTES + AES_TAG_BYTES})`
    );
  }

  return {
    iv: buffer.slice(0, AES_IV_BYTES),
    ciphertext: buffer.slice(AES_IV_BYTES, buffer.length - AES_TAG_BYTES),
    authTag: buffer.slice(buffer.length - AES_TAG_BYTES),
  };
}

// ── TACo Key Decryption ─────────────────────────────────────────────────────

export interface TacoDecryptionOptions {
  /** TACo domain (e.g., 'lynx', 'ursula') */
  domain: string;
  /** Ritual ID */
  ritualId: number;
  /** RPC URL for blockchain interaction */
  rpcUrl?: string;
  /** Private key for authentication */
  privateKey?: string;
}

export interface EncryptedKeyData {
  /** Base64-encoded encrypted AES key from TACo */
  encryptedKey: string;
  /** Hash of the original AES key */
  keyHash: string;
  /** Access control conditions used for encryption */
  accessControlConditions: AccessControlCondition[];
  /** Blockchain chain name */
  chain: string;
}

/**
 * Initialize TACo client for key decryption
 */
export async function createTacoDecryptor(options: TacoDecryptionOptions): Promise<{
  decryptKey: (encryptedKeyData: EncryptedKeyData) => Promise<Buffer>;
  disconnect: () => Promise<void>;
}> {
  // Dynamic import for optional dependency
  const { TacoClient } = await import("@nucypher/taco");
  const { AuthManager } = await import("@nucypher/taco-auth");
  const { ethers } = await import("ethers");

  // Map domain names to network configs
  const domainConfig: Record<string, string> = {
    'lynx': 'datil-dev',
    'ursula': 'datil-test',
    'datil-dev': 'datil-dev',
    'datil-test': 'datil-test',
    'datil': 'datil',
  };

  const networkName = domainConfig[options.domain] || 'datil-dev';

  console.log(`[tacO] Initializing TACo client for domain=${options.domain}, network=${networkName}`);

  // Create wallet from private key if provided
  let wallet: ethers.Wallet | undefined;
  if (options.privateKey) {
    const key = options.privateKey.startsWith("0x") 
      ? options.privateKey 
      : `0x${options.privateKey}`;
    wallet = new ethers.Wallet(key);
    console.log(`[tacO] Wallet address: ${wallet.address}`);
  }

  // Initialize TACo client
  const tacoClient = new TacoClient({
    network: networkName as any,
  });

  if (wallet) {
    await tacoClient.initialize(wallet);
  } else {
    await tacoClient.initialize();
  }

  const decryptKey = async (encryptedKeyData: EncryptedKeyData): Promise<Buffer> => {
    const { encryptedKey, keyHash, accessControlConditions, chain } = encryptedKeyData;

    console.log(`[tacO] Decrypting AES key (hash: ${keyHash.substring(0, 16)}...)`);

    try {
      // Convert access control conditions to TACo format
      const unifiedAccessControlConditions = accessControlConditions.map((acc) => ({
        conditionType: "evmBasic" as const,
        ...acc,
      }));

      // Create auth context if we have a wallet
      let authContext: any = undefined;
      if (wallet) {
        const authManager = new AuthManager();
        authContext = await authManager.createEoaAuthContext({
          tacoClient,
          wallet,
          resources: [['lit-access-control-condition-decryption', '*']],
        });
      }

      // Decrypt the key using TACo
      const ciphertext = Buffer.from(encryptedKey, "base64");
      
      const result = await tacoClient.decrypt({
        data: ciphertext,
        unifiedAccessControlConditions,
        authContext,
        chain,
      });

      const decryptedKey = Buffer.from(result.decryptedData);

      // Verify key hash
      const computedHash = crypto.createHash("sha256").update(decryptedKey).digest("hex");
      if (computedHash !== keyHash) {
        throw new Error(
          `Key hash mismatch: expected ${keyHash}, got ${computedHash}`
        );
      }

      console.log(`[tacO] AES key decrypted and verified successfully`);
      return decryptedKey;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`TACo decryption failed: ${errorMessage}`);
    }
  };

  const disconnect = async () => {
    await tacoClient.disconnect();
    console.log(`[tacO] Client disconnected`);
  };

  return { decryptKey, disconnect };
}

// ── Hybrid Decryption (AES + TACo) ──────────────────────────────────────────

export interface HybridEncryptedData {
  /** The AES-encrypted payload buffer */
  encryptedBuffer: Buffer;
  /** TACo encryption metadata */
  encryptionMetadata: EncryptionMetadata;
}

/**
 * Decrypt hybrid-encrypted data (AES-GCM payload + TACo-wrapped key)
 */
export async function decryptHybridData(
  encryptedData: HybridEncryptedData,
  options: TacoDecryptionOptions
): Promise<DecryptionResult> {
  try {
    const { encryptedBuffer, encryptionMetadata } = encryptedData;

    console.log(`[tacO] Starting hybrid decryption...`);
    console.log(`[tacO] Encrypted payload size: ${encryptedBuffer.length} bytes`);

    // Create TACo decryptor
    const { decryptKey, disconnect } = await createTacoDecryptor(options);

    try {
      // Prepare encrypted key data
      const encryptedKeyData: EncryptedKeyData = {
        encryptedKey: encryptionMetadata.encryptedKey,
        keyHash: encryptionMetadata.dataToEncryptHash,
        accessControlConditions: encryptionMetadata.accessControlConditions,
        chain: encryptionMetadata.chain,
      };

      // Decrypt AES key using TACo
      const aesKey = await decryptKey(encryptedKeyData);

      // Parse encrypted buffer
      const { iv, ciphertext, authTag } = parseEncryptedBuffer(encryptedBuffer);

      console.log(`[tacO] Decrypting payload with AES-256-GCM...`);

      // Decrypt payload with AES key
      const decrypted = aesDecrypt(
        Buffer.concat([ciphertext, authTag]),
        aesKey,
        iv
      );

      console.log(`[tacO] Payload decrypted successfully: ${decrypted.length} bytes`);

      return {
        success: true,
        decryptedBuffer: decrypted,
        encryptedBuffer,
      };
    } finally {
      await disconnect();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[tacO] Decryption failed: ${errorMessage}`);
    
    return {
      success: false,
      error: errorMessage,
      encryptedBuffer: encryptedData.encryptedBuffer,
    };
  }
}

// ── Metadata Parsing ────────────────────────────────────────────────────────

/**
 * Parse encryption metadata from IPLD/conversation data
 */
export function parseEncryptionMetadata(
  metadata: unknown
): EncryptionMetadata | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const meta = metadata as Record<string, unknown>;

  // Check for hybrid-v1 format
  if (meta.version === "hybrid-v1" && meta.encryptedKey && meta.keyHash) {
    return {
      version: "hybrid-v1",
      encryptedKey: meta.encryptedKey as string,
      dataToEncryptHash: meta.keyHash as string,
      algorithm: (meta.algorithm as "AES-GCM") || "AES-GCM",
      keyLength: (meta.keyLength as number) || 256,
      ivLengthBytes: (meta.ivLengthBytes as number) || 12,
      accessControlConditions: meta.accessControlConditions as AccessControlCondition[],
      chain: (meta.chain as string) || "ethereum",
    };
  }

  return null;
}

/**
 * Check if data appears to be encrypted
 */
export function isDataEncrypted(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  const meta = metadata as Record<string, unknown>;
  
  // Check for encryption indicators
  if (meta.encrypted === true) return true;
  if (meta.encryption?.encrypted === true) return true;
  if (meta.version === "hybrid-v1") return true;
  
  return false;
}

// ── Batch Decryption ────────────────────────────────────────────────────────

export interface BatchDecryptionResult {
  cid: string;
  success: boolean;
  decryptedBuffer?: Buffer;
  error?: string;
}

/**
 * Decrypt multiple encrypted buffers
 */
export async function batchDecrypt(
  items: Array<{ cid: string; encryptedBuffer: Buffer; metadata: EncryptionMetadata }>,
  options: TacoDecryptionOptions
): Promise<BatchDecryptionResult[]> {
  console.log(`[tacO] Decrypting ${items.length} items...`);

  const results: BatchDecryptionResult[] = [];

  for (const item of items) {
    console.log(`\n[tacO] Processing CID: ${item.cid}`);

    const result = await decryptHybridData(
      {
        encryptedBuffer: item.encryptedBuffer,
        encryptionMetadata: item.metadata,
      },
      options
    );

    results.push({
      cid: item.cid,
      success: result.success,
      decryptedBuffer: result.decryptedBuffer,
      error: result.error,
    });

    if (result.success) {
      console.log(`[tacO] ✓ CID ${item.cid} decrypted successfully`);
    } else {
      console.error(`[tacO] ✗ CID ${item.cid} failed: ${result.error}`);
    }
  }

  return results;
}
