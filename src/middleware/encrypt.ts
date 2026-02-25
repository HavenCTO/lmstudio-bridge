/**
 * Lit Protocol hybrid encryption middleware.
 *
 * Encrypts the combined request + response payload using AES-256-GCM
 * locally, then wraps the AES key with Lit Protocol BLS-IBE so only
 * wallets that satisfy the configured access-control conditions can
 * decrypt.
 *
 * If the gzip middleware ran first, this operates on the compressed
 * buffer (which already contains the combined request+response).
 * Otherwise it serialises a combined `{ request, response }` JSON
 * payload itself, capturing the request during `onRequest`.
 *
 * This works transparently with all OpenAI content formats including
 * multi-part messages that carry inline base64 images (`image_url`
 * content parts).
 *
 * Required configuration:
 *   --encrypt                      Enable encryption
 *   --lit-network <network>        Lit network (default "datil-dev")
 *   --lit-private-key <hex>        Wallet private key (or HAVEN_PRIVATE_KEY env)
 *   --lit-chain <chain>            EVM chain for ACCs (default "ethereum")
 *
 * After this middleware runs the following metadata keys are set:
 *   - `capturedRequest`    – the original OpenAI request (if not already set)
 *   - `encryptedBuffer`    – Buffer of IV + AES-GCM ciphertext + auth tag
 *
 * Session-level metadata (Lit-wrapped key, ACCs, algorithm info) is
 * available via `getSessionMetadata()` and should be uploaded once at
 * startup rather than per-request.
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

/**
 * Create owner-only access control conditions.
 * Only the encrypting wallet can decrypt.
 */
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

// ── Lit Protocol integration types ──────────────────────────────────────────

/**
 * Result of encrypting the AES key via Lit Protocol.
 * Matches the shape returned by the Lit SDK `encrypt()` call.
 */
export interface LitKeyEncryptionResult {
  /** Base64-encoded ciphertext from Lit BLS-IBE */
  ciphertext: string;
  /** SHA-256 hash of the plaintext AES key (hex) */
  dataToEncryptHash: string;
}

/**
 * Callback that performs the actual Lit Protocol key encryption.
 *
 * This allows the middleware to remain unit-testable without pulling
 * in the full Lit SDK. In production, wire this up to:
 *   `LitNodeClient.encrypt({ dataToEncrypt, unifiedAccessControlConditions })`
 *
 * The function receives:
 *   - aesKey: the raw 32-byte AES key
 *   - accessControlConditions: the ACCs to embed
 *   - chain: the EVM chain identifier
 * And must return a `LitKeyEncryptionResult`.
 */
export type LitEncryptKeyFn = (
  aesKey: Buffer,
  accessControlConditions: AccessControlCondition[],
  chain: string
) => Promise<LitKeyEncryptionResult>;

/**
 * Callback that decrypts the AES key back from Lit Protocol.
 *
 * The function receives the encrypted key material and ACCs, and
 * returns the raw 32-byte AES key.  Used to recover a previously
 * persisted key on startup.
 */
export type LitDecryptKeyFn = (
  ciphertext: string,
  dataToEncryptHash: string,
  accessControlConditions: AccessControlCondition[],
  chain: string
) => Promise<Uint8Array>;

/**
 * Metadata stored alongside the encrypted payload.
 * Compatible with js-services HybridEncryptionMetadata.
 */
export interface EncryptionMetadata {
  version: "hybrid-v1";
  encryptedKey: string;
  keyHash: string;
  algorithm: "AES-GCM";
  keyLength: 256;
  ivLengthBytes: 12;
  accessControlConditions: AccessControlCondition[];
  chain: string;
  /**
   * IPFS CID of this metadata JSON once uploaded.
   * Present only in the persisted key metadata file (shared key mode).
   * Set after the first successful upload so subsequent sessions skip
   * the redundant upload.
   */
  metadataCid?: string;
}

// ── Default Lit SDK key-encryption implementation ───────────────────────────

/**
 * Create a `LitEncryptKeyFn` backed by the real `@lit-protocol/lit-node-client`.
 *
 * Lazily connects on first call and reuses the connection for subsequent
 * encryptions.  Call `disconnect()` on the returned handle to clean up.
 *
 * ```ts
 * const litKey = createLitKeyEncryptor({ network: "datil-dev" });
 * const mw = createEncryptMiddleware({ litEncryptKey: litKey.encrypt, ... });
 * // later…
 * await litKey.disconnect();
 * ```
 */
export function createLitKeyEncryptor(opts: {
  network?: string;
  /** Wallet private key (hex) – needed for generating session signatures for decryption */
  privateKey?: string;
  /** EVM chain for session signatures (default "ethereum") */
  chain?: string;
}): {
  encrypt: LitEncryptKeyFn;
  decrypt: LitDecryptKeyFn;
  disconnect: () => Promise<void>;
} {
  const network = opts.network ?? "datil-dev";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clientPromise: Promise<any> | null = null;

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        // Dynamic import so the SDK is optional at install time
        // @ts-ignore – optional peer dependency
        const { LitNodeClient } = await import("@lit-protocol/lit-node-client");
        const client = new LitNodeClient({ litNetwork: network as any });
        await client.connect();
        return client;
      })();
    }
    return clientPromise;
  }

  const encrypt: LitEncryptKeyFn = async (aesKey, accs, chain) => {
    const client = await getClient();

    const unifiedAccessControlConditions = accs.map((a) => ({
      conditionType: "evmBasic" as const,
      ...a,
    }));

    const result = await client.encrypt({
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
    const client = await getClient();

    const unifiedAccessControlConditions = accs.map((a) => ({
      conditionType: "evmBasic" as const,
      ...a,
    }));

    // Obtain session signatures using the wallet private key
    if (!opts.privateKey) {
      throw new Error(
        "[lit] privateKey is required for decryption (session signature generation)"
      );
    }

    // Dynamic import so ethers is optional
    // @ts-ignore – optional peer dependency
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(
      opts.privateKey.startsWith("0x")
        ? opts.privateKey
        : `0x${opts.privateKey}`
    );

    const sessionSigs = await client.getSessionSigs({
      chain: decryptChain,
      resourceAbilityRequests: [
        {
          // @ts-ignore – optional peer dependency types
          resource: new (await import("@lit-protocol/auth-helpers")).LitAccessControlConditionResource("*"),
          // @ts-ignore – optional peer dependency types
          ability: (await import("@lit-protocol/constants")).LitAbility.AccessControlConditionDecryption,
        },
      ],
      authNeededCallback: async (params: any) => {
        const toSign = await (client as any).createMessage({
          ...params,
        });
        const authSig = {
          sig: await wallet.signMessage(toSign),
          derivedVia: "web3.eth.personal.sign",
          signedMessage: toSign,
          address: wallet.address.toLowerCase(),
        };
        return authSig;
      },
    });

    const result = await client.decrypt({
      ciphertext,
      dataToEncryptHash,
      unifiedAccessControlConditions,
      chain: decryptChain,
      sessionSigs,
    });

    return result.decryptedData;
  };

  const disconnect = async () => {
    if (clientPromise) {
      const client = await clientPromise;
      await client.disconnect();
      clientPromise = null;
    }
  };

  return { encrypt, decrypt, disconnect };
}

// ── Middleware factory ──────────────────────────────────────────────────────

export interface EncryptMiddlewareOptions {
  /**
   * Function that encrypts the AES key with Lit Protocol.
   * Use `createLitKeyEncryptor()` for the real SDK, or supply a stub
   * for testing / environments without Lit nodes.
   */
  litEncryptKey: LitEncryptKeyFn;

  /**
   * Function that decrypts the AES key from Lit Protocol.
   * Required when `keyMetadataPath` is set (shared key mode).
   */
  litDecryptKey?: LitDecryptKeyFn;

  /** Wallet address that owns the encrypted content */
  walletAddress: string;

  /** EVM chain for access-control conditions (default "ethereum") */
  chain?: string;

  /**
   * Path to a local JSON file where the encryption metadata (Lit-wrapped
   * key, ACCs, algorithm info) is persisted.
   *
   * When set, the middleware operates in **shared key mode**:
   *   - If the file exists on startup, the AES key is recovered by
   *     decrypting it from the Lit network instead of generating a new one.
   *   - If the file does not exist, a new key is generated, wrapped via
   *     Lit, and written to this path for future sessions.
   *
   * This means every shim session reuses the same AES-256 key (and therefore
   * the same encryption metadata CID), eliminating the need for per-session
   * key management.
   */
  keyMetadataPath?: string;
}

/**
 * Handle returned by `createEncryptMiddleware` so the caller can
 * clean up the cached AES key material on shutdown.
 */
export interface EncryptMiddlewareHandle {
  middleware: Middleware;
  /**
   * Initialise the middleware by generating an AES-256 key and
   * encrypting it once via Lit Protocol.  Must be awaited before the
   * middleware processes any requests.
   */
  initialize: () => Promise<void>;
  /**
   * Return the session-level encryption metadata (Lit-wrapped key,
   * ACCs, algorithm info).  Available after `initialize()`.
   * Upload this once and share the CID with decryptors.
   */
  getSessionMetadata: () => EncryptionMetadata;
  /**
   * Zero the cached AES key.  Call on graceful shutdown.
   */
  destroy: () => void;
}

/**
 * Create the Lit-based encryption middleware.
 *
 * The AES key is generated once and wrapped via Lit Protocol during
 * `initialize()`.  Each request reuses the cached key with a fresh
 * random IV (nonce).  AES-256-GCM with a unique 96-bit nonce per
 * message is safe for up to ~2^32 encryptions — more than enough for
 * an LLM shim's lifetime.
 *
 * ```ts
 * const handle = createEncryptMiddleware({ litEncryptKey, walletAddress });
 * await handle.initialize();          // one-time Lit call
 * engine.use(handle.middleware);
 * // on shutdown…
 * handle.destroy();
 * ```
 */
export function createEncryptMiddleware(
  options: EncryptMiddlewareOptions
): EncryptMiddlewareHandle {
  const { litEncryptKey, walletAddress } = options;
  const chain = options.chain ?? "ethereum";

  // Cached key material — populated once by initialize()
  let cachedAESKey: Buffer | null = null;
  let cachedLitResult: LitKeyEncryptionResult | null = null;
  let cachedACCs: AccessControlCondition[] | null = null;

  const initialize = async (): Promise<void> => {
    const fs = await import("fs");
    cachedACCs = createOwnerOnlyACC(walletAddress, chain);

    // ── Shared key mode: try to recover a persisted key ──
    if (options.keyMetadataPath && fs.existsSync(options.keyMetadataPath)) {
      if (!options.litDecryptKey) {
        throw new Error(
          "[encrypt] litDecryptKey is required when keyMetadataPath points to an existing file"
        );
      }

      console.log(
        `[encrypt] found persisted key metadata at ${options.keyMetadataPath} — recovering key from Lit…`
      );

      const persisted: EncryptionMetadata = JSON.parse(
        fs.readFileSync(options.keyMetadataPath, "utf-8")
      );

      // Recover the raw AES key via Lit Protocol decryption
      const decrypted = await options.litDecryptKey(
        persisted.encryptedKey,
        persisted.keyHash,
        persisted.accessControlConditions,
        persisted.chain
      );

      if (decrypted.length !== AES_KEY_BYTES) {
        throw new Error(
          `[encrypt] recovered key is ${decrypted.length} bytes, expected ${AES_KEY_BYTES}`
        );
      }

      // Verify integrity
      const recoveredKey = Buffer.from(decrypted);
      const recoveredHash = sha256Hex(recoveredKey);
      if (recoveredHash !== persisted.keyHash) {
        throw new Error(
          "[encrypt] recovered key hash mismatch — key recovery failed"
        );
      }

      cachedAESKey = recoveredKey;
      cachedLitResult = {
        ciphertext: persisted.encryptedKey,
        dataToEncryptHash: persisted.keyHash,
      };

      console.log(
        "[encrypt] AES key recovered from Lit Protocol (shared key mode)"
      );
      return;
    }

    // ── Fresh key: generate, wrap via Lit, optionally persist ──
    cachedAESKey = generateAESKey();
    cachedLitResult = await litEncryptKey(cachedAESKey, cachedACCs, chain);
    console.log(
      "[encrypt] AES key generated and wrapped via Lit Protocol (cached for session)"
    );

    if (options.keyMetadataPath) {
      const metadata = getSessionMetadata();
      const dir = (await import("path")).dirname(options.keyMetadataPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.keyMetadataPath,
        JSON.stringify(metadata, null, 2),
        "utf-8"
      );
      console.log(
        `[encrypt] key metadata persisted to ${options.keyMetadataPath} (shared key mode)`
      );
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
      // Capture the request if not already captured by an earlier middleware (e.g. gzip)
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
          "[encrypt] middleware not initialised — call initialize() before processing requests"
        );
      }

      // Determine what to encrypt: prefer the gzip buffer if available
      // (which already contains the combined request+response).
      // Otherwise build a combined { request, response } payload.
      let plaintext: Buffer;
      if (payload.context.metadata.gzipBuffer) {
        plaintext = payload.context.metadata.gzipBuffer as Buffer;
      } else {
        const combined = {
          request: payload.context.metadata.capturedRequest ?? null,
          response: payload.openaiResponse,
        };
        plaintext = Buffer.from(
          JSON.stringify(combined),
          "utf-8"
        );
      }

      const originalSize = plaintext.length;
      const originalHash = sha256Hex(plaintext);

      // AES-256-GCM encrypt with the cached key and a fresh IV
      const iv = generateIV();
      const { ciphertext, authTag } = aesEncrypt(plaintext, cachedAESKey, iv);

      // Combine IV + ciphertext + authTag into a single self-contained blob.
      // Decryptors read the first 12 bytes as IV, last 16 as auth tag.
      const encryptedBuffer = Buffer.concat([iv, ciphertext, authTag]);

      // Store in context for downstream middleware (e.g. upload).
      // Session-level metadata (Lit key, ACCs) is uploaded once at startup,
      // not per-request — see getSessionMetadata().
      payload.context.metadata.encryptedBuffer = encryptedBuffer;

      console.log(
        `[encrypt] ${payload.context.requestId} | ${originalSize} → ${encryptedBuffer.length} bytes (AES-256-GCM, cached key)`
      );

      await next();
    },
  };

  const getSessionMetadata = (): EncryptionMetadata => {
    if (!cachedLitResult || !cachedACCs) {
      throw new Error(
        "[encrypt] middleware not initialised — call initialize() first"
      );
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
