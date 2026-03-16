/**
 * TACo (Threshold Access Control) Encryption Middleware
 * 
 * Replaces Lit Protocol encryption with TACo SDK for DAO token-holder gated access.
 * Encrypts the combined request + response payload using AES-256-GCM locally,
 * then uses TACo threshold encryption so only wallets satisfying the DAO condition
 * can decrypt.
 */

import * as crypto from 'crypto';
import { createRequire } from 'module';
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from '../types';

// Create require function for ES modules
const require = createRequire(import.meta.url);

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
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, authTag };
}

function bufferToBase64(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ── TACo Encryption Types ───────────────────────────────────────────────────

export interface TacoEncryptionMetadata {
  version: 'taco-v1';
  encryptedKey: string; // Base64 encoded encrypted AES key
  keyHash: string; // SHA256 hash of the AES key
  algorithm: 'AES-GCM';
  keyLength: number;
  ivLengthBytes: number;
  tacoDomain: string;
  ritualId: number;
  condition: Record<string, unknown>;
  chain: string;
  metadataCid?: string;
}

export interface TacoEncryptOptions {
  /** TACo domain/network (e.g., 'lynx' for DEVNET) */
  tacoDomain: string;
  /** Ritual ID for the DKG ritual */
  ritualId: number;
  /** DAO token contract address */
  daoContractAddress: string;
  /** Blockchain chain name */
  daoChain: string;
  /** Minimum token balance required */
  minimumBalance?: string;
  /** Optional private key for key recovery (shared key mode) */
  privateKey?: string;
  /** Path to persist encryption metadata (enables shared key across sessions) */
  keyMetadataPath?: string;
}

export interface TacoEncryptMiddlewareHandle {
  middleware: Middleware;
  initialize: () => Promise<void>;
  getSessionMetadata: () => TacoEncryptionMetadata;
  destroy: () => void;
}

// ── TACo Key Wrapper Class ──────────────────────────────────────────────────

class TacoKeyWrapper {
  private client: any | null = null;
  private provider: any | null = null;
  private signer: any | null = null;
  
  constructor(private options: TacoEncryptOptions) {}

  async initialize(): Promise<void> {
    console.log(`[taco-key-wrapper] Initializing TACo client for domain=${this.options.tacoDomain}, ritualId=${this.options.ritualId}`);
    
    try {
      // Initialize nucypher-core WASM module synchronously
      // This avoids the async WASM loading issues in Node.js
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nucypherCore = require('@nucypher/nucypher-core');
      
      // Load WASM bytes directly and use initSync
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path');
      
      const wasmPath = path.join(
        require.resolve('@nucypher/nucypher-core'),
        '..',
        '..',
        'nucypher_core_wasm_bg.wasm'
      );
      
      const wasmBytes = fs.readFileSync(wasmPath);
      nucypherCore.initSync(wasmBytes);
      
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ethers = require('ethers');
      
      // Create provider for Amoy (L2 chain for DEVNET - where Coordinator contract is deployed)
      // The Coordinator contract for lynx/DEVNET is on Amoy (80002), not Sepolia (11155111)
      this.provider = new ethers.providers.JsonRpcProvider(
        'https://rpc-amoy.polygon.technology'
      );
      
      // Set up signer if private key provided
      if (this.options.privateKey) {
        const wallet = new ethers.Wallet(
          this.options.privateKey.startsWith('0x') 
            ? this.options.privateKey 
            : `0x${this.options.privateKey}`
        );
        this.signer = wallet.connect(this.provider);
      }
      
      console.log('[taco-key-wrapper] TACo client initialized');
    } catch (error) {
      console.error('[taco-key-wrapper] Initialization failed:', error);
      throw new Error(`TACo key wrapper initialization failed: ${error}`);
    }
  }

  async encryptKey(aesKey: Buffer): Promise<{ encryptedKey: string; keyHash: string }> {
    if (!this.provider || !this.signer) {
      throw new Error('TACo client not initialized');
    }
    
    console.log('[taco-key-wrapper] Encrypting AES key with TACo...');
    
    try {
      // Use require with main entry point - resolves to CJS build
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tacoCJS = require('@nucypher/taco');
      const { encrypt, domains, conditions } = tacoCJS;
      
      // Use the ERC20Balance predefined condition class
      const { ERC20Balance } = conditions.predefined.erc20;
      
      // Build DAO token holder condition using the predefined class
      // chain must be a number (chain ID), not a string
      const chainId = typeof this.options.daoChain === 'string' 
        ? parseInt(this.options.daoChain, 10) 
        : this.options.daoChain;
      
      const condition = new ERC20Balance({
        contractAddress: this.options.daoContractAddress.toLowerCase(),
        chain: chainId,
        returnValueTest: {
          comparator: '>=',
          value: this.options.minimumBalance || '1',
        },
      });
      
      // Encrypt the key using TACo
      const messageKit = await encrypt(
        this.provider,
        domains.DEVNET, // Use DEVNET domain
        aesKey,
        condition,
        this.options.ritualId,
        this.signer
      );
      
      const encryptedKey = bufferToBase64(messageKit.toBytes());
      const keyHash = sha256Hex(aesKey);
      
      console.log('[taco-key-wrapper] AES key encrypted successfully');
      
      return { encryptedKey, keyHash };
    } catch (error) {
      console.error('[taco-key-wrapper] Key encryption failed:', error);
      throw new Error(`TACo key encryption failed: ${error}`);
    }
  }

  async decryptKey(encryptedKey: string, keyHash: string): Promise<Buffer> {
    if (!this.provider) {
      throw new Error('TACo client not initialized');
    }
    
    console.log('[taco-key-wrapper] Decrypting AES key with TACo...');
    
    try {
      const tacoModule = await import('@nucypher/taco');
      const { decrypt, domains } = tacoModule;
      
      // @ts-ignore - dynamic path may not resolve in static analysis
      const contextModule = await import('@nucypher/taco/conditions/context');
      const { ConditionContext } = contextModule;
      
      // Deserialize the encrypted key
      const messageKitBytes = Buffer.from(encryptedKey, 'base64');
      
      // @ts-ignore - nucypher-core types
      const { ThresholdMessageKit } = await import('@nucypher/nucypher-core');
      const messageKit = ThresholdMessageKit.fromBytes(new Uint8Array(messageKitBytes));
      
      // Build condition (same as encryption)
      const conditionProps = {
        contractAddress: this.options.daoContractAddress.toLowerCase(),
        standardContractType: 'ERC20',
        chain: this.options.daoChain,
        method: 'balanceOf',
        parameters: [':userAddress'],
        returnValueTest: {
          comparator: '>=',
          value: this.options.minimumBalance || '1',
        },
      };
      
      // Create auth provider for decryption
      const authModule = await import('@nucypher/taco-auth');
      const { EIP4361AuthProvider } = authModule;
      
      if (!this.signer) {
        throw new Error('Signer required for decryption');
      }
      
      const authProvider = new EIP4361AuthProvider(this.provider, this.signer);
      const context = new ConditionContext(authProvider, conditionProps);
      
      // Decrypt
      const decryptedBytes = await decrypt(
        this.provider,
        domains.DEVNET,
        messageKit,
        context
      );
      
      const decryptedKey = Buffer.from(decryptedBytes);
      
      // Verify key hash
      const recoveredHash = sha256Hex(decryptedKey);
      if (recoveredHash !== keyHash) {
        throw new Error('Decrypted key hash mismatch');
      }
      
      console.log('[taco-key-wrapper] AES key decrypted successfully');
      
      return decryptedKey;
    } catch (error) {
      console.error('[taco-key-wrapper] Key decryption failed:', error);
      throw new Error(`TACo key decryption failed: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.provider = null;
    this.signer = null;
    console.log('[taco-key-wrapper] Disconnected');
  }
}

// ── Middleware Factory ──────────────────────────────────────────────────────

export function createTacoKeyWrapper(options: TacoEncryptOptions): TacoKeyWrapper {
  return new TacoKeyWrapper(options);
}

export function createTacoEncryptMiddleware(
  options: TacoEncryptOptions
): TacoEncryptMiddlewareHandle {
  const keyWrapper = createTacoKeyWrapper(options);
  
  let cachedAESKey: Buffer | null = null;
  let cachedMetadata: TacoEncryptionMetadata | null = null;
  
  const initialize = async (): Promise<void> => {
    const fs = await import('fs');
    
    await keyWrapper.initialize();
    
    // Try to recover persisted key in shared key mode
    if (options.keyMetadataPath && fs.existsSync(options.keyMetadataPath)) {
      if (!options.privateKey) {
        throw new Error(
          '[taco-encrypt] privateKey required when recovering persisted key'
        );
      }
      
      console.log(`[taco-encrypt] Recovering key from ${options.keyMetadataPath}...`);
      
      const persisted: TacoEncryptionMetadata = JSON.parse(
        fs.readFileSync(options.keyMetadataPath, 'utf-8')
      );
      
      cachedAESKey = await keyWrapper.decryptKey(
        persisted.encryptedKey,
        persisted.keyHash
      );
      cachedMetadata = persisted;
      
      console.log('[taco-encrypt] AES key recovered from TACo');
      return;
    }
    
    // Generate new key
    cachedAESKey = generateAESKey();
    const { encryptedKey, keyHash } = await keyWrapper.encryptKey(cachedAESKey);
    
    cachedMetadata = {
      version: 'taco-v1',
      encryptedKey,
      keyHash,
      algorithm: 'AES-GCM',
      keyLength: 256,
      ivLengthBytes: 12,
      tacoDomain: options.tacoDomain,
      ritualId: options.ritualId,
      condition: {
        contractAddress: options.daoContractAddress.toLowerCase(),
        standardContractType: 'ERC20',
        chain: options.daoChain,
        method: 'balanceOf',
        parameters: [':userAddress'],
        returnValueTest: {
          comparator: '>=',
          value: options.minimumBalance || '1',
        },
      },
      chain: options.daoChain,
    };
    
    console.log('[taco-encrypt] AES key generated and wrapped via TACo');
    
    // Persist metadata if path provided
    if (options.keyMetadataPath) {
      const dir = (await import('path')).dirname(options.keyMetadataPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.keyMetadataPath,
        JSON.stringify(cachedMetadata, null, 2),
        'utf-8'
      );
      console.log(`[taco-encrypt] Key metadata persisted to ${options.keyMetadataPath}`);
    }
  };
  
  const destroy = (): void => {
    if (cachedAESKey) {
      cachedAESKey.fill(0);
      cachedAESKey = null;
    }
    cachedMetadata = null;
  };
  
  const middleware: Middleware = {
    name: 'taco-encrypt',
    
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
      if (!cachedAESKey || !cachedMetadata) {
        throw new Error(
          '[taco-encrypt] middleware not initialised — call initialize() first'
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
        plaintext = Buffer.from(JSON.stringify(combined), 'utf-8');
      }
      
      const originalSize = plaintext.length;
      const iv = generateIV();
      const { ciphertext, authTag } = aesEncrypt(plaintext, cachedAESKey, iv);
      const encryptedBuffer = Buffer.concat([iv, ciphertext, authTag]);
      
      payload.context.metadata.encryptedBuffer = encryptedBuffer;
      
      console.log(
        `[taco-encrypt] ${payload.context.requestId} | ${originalSize} → ${encryptedBuffer.length} bytes (AES-256-GCM)`
      );
      
      await next();
    },
  };
  
  const getSessionMetadata = (): TacoEncryptionMetadata => {
    if (!cachedMetadata) {
      throw new Error('[taco-encrypt] middleware not initialised');
    }
    return cachedMetadata;
  };
  
  return { middleware, initialize, getSessionMetadata, destroy };
}
