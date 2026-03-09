/**
 * Lit Protocol v8 (Naga) encryption middleware.
 *
 * Encrypts the combined request + response payload using AES-256-GCM
 * locally, then wraps the AES key with Lit Protocol BLS-IBE so only
 * wallets that satisfy the configured access-control conditions can
 * decrypt.
 */

import * as crypto from "crypto";
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from "../types";

// ── AES-256-GCM helpers (Node.js native crypto) ────────────────────────────

const AES_KEY_BYTES = 32; // 256 bits
const AES_IV_BYTES = 12;  // 96-bit nonce recommended for GCM
const AES_TAG_BYTES = 16; // 128-bit auth tag

function generateAESKey(): Buffer {
  return crypto.randomBytes(AES_KEY_BYTES);
}

function generateIV(): Buffer {
  return crypto.randomBytes(AES_IV_BYTES);
}

function aesEncrypt(
  plaintext: Buffer,
  key: Buffer,
  iv: Buffer
): { ciphertext: Buffer; authTag: Buffer } {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, authTag };
}

function bufferToBase64(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ── Access-control condition helpers ────────────────────────────────────────

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

function createOwnerOnlyACC(
  walletAddress: string,
  chain: string
): AccessControlCondition[] {
  return [
    {
      contractAddress: "",
      standardContractType: "",
      chain,
      method: "",
      parameters: [":userAddress"],
      returnValueTest: {
        comparator: "=",
        value: walletAddress.toLowerCase(),
      },
    },
  ];
}

// ── Lit Protocol v8 integration types ───────────────────────────────────────

export interface LitKeyEncryptionResult {
  ciphertext: string;
  dataToEncryptHash: string;
}

export type LitEncryptKeyFn = (
  aesKey: Buffer,
  accessControlConditions: AccessControlCondition[],
  chain: string
) => Promise<LitKeyEncryptionResult>;

export type LitDecryptKeyFn = (
  ciphertext: string,
  dataToEncryptHash: string,
  accessControlConditions: AccessControlCondition[],
  chain: string
) => Promise<Uint8Array>;

export interface EncryptionMetadata {
  version: "hybrid-v1";
  encryptedKey: string;
  keyHash: string;
  algorithm: "AES-GCM";
  keyLength: number;
  ivLengthBytes: number;
  accessControlConditions: AccessControlCondition[];
  chain: string;
  metadataCid?: string;
}

// ── Lit Protocol v8 key-encryption implementation ───────────────────────────

export function createLitKeyEncryptor(opts: {
  network?: string;
  privateKey?: string;
  chain?: string;
}): {
  encrypt: LitEncryptKeyFn;
  decrypt: LitDecryptKeyFn;
  disconnect: () => Promise<void>;
} {
  const networkName = opts.network ?? "naga-dev";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any | null = null;

  async function getClient() {
    if (!client) {
      // Dynamic import for v8 SDK
      // @ts-ignore – optional peer dependency
      const { createLitClient } = await import("@lit-protocol/lit-client");
      // @ts-ignore – optional peer dependency
      const { nagaDev, nagaTest, naga } = await import("@lit-protocol/networks");
      
      // Get network module
      const networkMap: Record<string, any> = {
        'naga-dev': nagaDev,
        'nagaDev': nagaDev,
        'naga-test': nagaTest,
        'nagaTest': nagaTest,
        'naga': naga,
      };
      
      const networkModule = networkMap[networkName] || nagaDev;
      
      client = await createLitClient({ network: networkModule });
    }
    return client;
  }

  const encrypt: LitEncryptKeyFn = async (aesKey, accs, chain) => {
    const litClient = await getClient();

    const unifiedAccessControlConditions = accs.map((a) => ({
      conditionType: "evmBasic" as const,
      ...a,
    }));

    // v8 API: litClient.encrypt()
    const result = await litClient.encrypt({
      dataToEncrypt: new Uint8Array(aesKey),
      unifiedAccessControlConditions,
      chain,
    });

    return {
      ciphertext: result.ciphertext,
      dataToEncryptHash: result.dataToEncryptHash,
    };
  };

  const decrypt: LitDecryptKeyFn = async (
    ciphertext,
    dataToEncryptHash,
    accs,
    decryptChain
  ) => {
    const litClient = await getClient();

    if (!opts.privateKey) {
      throw new Error(
        "[lit] privateKey is required for decryption (auth context generation)"
      );
    }

    // v8 API: Use AuthManager instead of getSessionSigs
    // @ts-ignore – optional peer dependency
    const { AuthManager } = await import("@lit-protocol/auth");
    // @ts-ignore – optional peer dependency
    const { ethers } = await import("ethers");
    
    const wallet = new ethers.Wallet(
      opts.privateKey.startsWith("0x")
        ? opts.privateKey
        : `0x${opts.privateKey}`
    );

    const authManager = new AuthManager();
    const authContext = await authManager.createEoaAuthContext({
      litClient,
      wallet,
      resources: [['lit-access-control-condition-decryption', '*']],
    });

    const unifiedAccessControlConditions = accs.map((a) => ({
      conditionType: "evmBasic" as const,
      ...a,
    }));

    // v8 API: litClient.decrypt() with authContext
    const result = await litClient.decrypt({
      data: ciphertext,
      unifiedAccessControlConditions,
      authContext,
      chain: decryptChain,
    });

    return result.decryptedData;
  };

  const disconnect = async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  };

  return { encrypt, decrypt, disconnect };
}

// ── Middleware factory ──────────────────────────────────────────────────────

export interface EncryptMiddlewareOptions {
  litEncryptKey: LitEncryptKeyFn;
  litDecryptKey?: LitDecryptKeyFn;
  walletAddress: string;
  chain?: string;
  keyMetadataPath?: string;
}

export interface EncryptMiddlewareHandle {
  middleware: Middleware;
  initialize: () => Promise<void>;
  getSessionMetadata: () => EncryptionMetadata;
  destroy: () => void;
}

export function createEncryptMiddleware(
  options: EncryptMiddlewareOptions
): EncryptMiddlewareHandle {
  const { litEncryptKey, walletAddress } = options;
  const chain = options.chain ?? "ethereum";

  let cachedAESKey: Buffer | null = null;
  let cachedLitResult: LitKeyEncryptionResult | null = null;
  let cachedACCs: AccessControlCondition[] | null = null;

  const initialize = async (): Promise<void> => {
    const fs = await import("fs");
    cachedACCs = createOwnerOnlyACC(walletAddress, chain);

    // Shared key mode: try to recover persisted key
    if (options.keyMetadataPath && fs.existsSync(options.keyMetadataPath)) {
      if (!options.litDecryptKey) {
        throw new Error(
          "[encrypt] litDecryptKey required when keyMetadataPath exists"
        );
      }

      console.log(
        `[encrypt] Recovering key from ${options.keyMetadataPath}...`
      );

      const persisted: EncryptionMetadata = JSON.parse(
        fs.readFileSync(options.keyMetadataPath, "utf-8")
      );

      const decrypted = await options.litDecryptKey(
        persisted.encryptedKey,
        persisted.keyHash,
        persisted.accessControlConditions,
        persisted.chain
      );

      if (decrypted.length !== AES_KEY_BYTES) {
        throw new Error(
          `[encrypt] Recovered key is ${decrypted.length} bytes, expected ${AES_KEY_BYTES}`
        );
      }

      const recoveredKey = Buffer.from(decrypted);
      const recoveredHash = sha256Hex(recoveredKey);
      if (recoveredHash !== persisted.keyHash) {
        throw new Error("[encrypt] Key hash mismatch");
      }

      cachedAESKey = recoveredKey;
      cachedLitResult = {
        ciphertext: persisted.encryptedKey,
        dataToEncryptHash: persisted.keyHash,
      };

      console.log("[encrypt] AES key recovered from Lit Protocol");
      return;
    }

    // Generate new key
    cachedAESKey = generateAESKey();
    cachedLitResult = await litEncryptKey(cachedAESKey, cachedACCs, chain);
    console.log("[encrypt] AES key generated and wrapped via Lit Protocol");

    if (options.keyMetadataPath) {
      const metadata = getSessionMetadata();
      const dir = (await import("path")).dirname(options.keyMetadataPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.keyMetadataPath,
        JSON.stringify(metadata, null, 2),
        "utf-8"
      );
      console.log(`[encrypt] Key metadata persisted to ${options.keyMetadataPath}`);
    }
  };

  const destroy = (): void => {
    if (cachedAESKey) {
      cachedAESKey.fill(0);
      cachedAESKey = null;
    }
    cachedLitResult = null;
    cachedACCs = null;
  };

  const middleware: Middleware = {
    name: "encrypt",

    async onRequest(
      payload: RequestPayload,
      next: NextFunction
    ): Promise<void> {
      if (!payload.context.metadata.capturedRequest) {
        payload.context.metadata.capturedRequest = payload.openaiRequest;
      }
      await next();
    },

    async onResponse(
      payload: ResponsePayload,
      next: NextFunction
    ): Promise<void> {
      if (!cachedAESKey || !cachedLitResult || !cachedACCs) {
        throw new Error(
          "[encrypt] middleware not initialised — call initialize() first"
        );
      }

      let plaintext: Buffer;
      if (payload.context.metadata.gzipBuffer) {
        plaintext = payload.context.metadata.gzipBuffer as Buffer;
      } else {
        const combined = {
          request: payload.context.metadata.capturedRequest ?? null,
          response: payload.openaiResponse,
        };
        plaintext = Buffer.from(JSON.stringify(combined), "utf-8");
      }

      const originalSize = plaintext.length;
      const originalHash = sha256Hex(plaintext);

      const iv = generateIV();
      const { ciphertext, authTag } = aesEncrypt(plaintext, cachedAESKey, iv);
      const encryptedBuffer = Buffer.concat([iv, ciphertext, authTag]);

      payload.context.metadata.encryptedBuffer = encryptedBuffer;

      console.log(
        `[encrypt] ${payload.context.requestId} | ${originalSize} → ${encryptedBuffer.length} bytes (AES-256-GCM, cached key)`
      );

      await next();
    },
  };

  const getSessionMetadata = (): EncryptionMetadata => {
    if (!cachedLitResult || !cachedACCs) {
      throw new Error("[encrypt] middleware not initialised");
    }
    return {
      version: "hybrid-v1",
      encryptedKey: cachedLitResult.ciphertext,
      keyHash: cachedLitResult.dataToEncryptHash,
      algorithm: "AES-GCM",
      keyLength: 256,
      ivLengthBytes: 12,
      accessControlConditions: cachedACCs,
      chain,
    };
  };

  return { middleware, initialize, getSessionMetadata, destroy };
}
