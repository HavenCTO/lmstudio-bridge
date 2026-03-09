# S2-T3: Rewrite `createEncryptMiddleware()` Using TACo APIs

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** S2-T1 (Lit archived), S2-T2 (TacoKeyWrapper created)  
**Acceptance Criteria:**
- [ ] `src/middleware/encrypt.ts` completely rewritten with TACo backend
- [ ] Function signatures unchanged from Lit version (drop-in replacement)
- [ ] Middleware behavior identical: AES-GCM encrypt payload, TACo wrap key
- [ ] CLI flags updated in `src/index.ts` (S2-T4 handles this separately but test here)
- [ ] Unit tests pass for middleware logic
- [ ] Session recovery works (persist/reload key metadata)

---

## Technical Specification

### Original Signature (from Lit v8 implementation)

```typescript
export function createEncryptMiddleware(
  options: EncryptMiddlewareOptions
): EncryptMiddlewareHandle {
  // ...
}

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
```

### New Signature (TACo-based - Interface STAYS THE SAME)

```typescript
export function createEncryptMiddleware(
  options: EncryptMiddlewareOptions & {
    // Additional TACo-specific configs (optional, sensible defaults provided)
    tacoRpcUrl?: string;
    tacoRitualId?: number;
    daoContractAddress: string;  // REQUIRED for TACo
    daoChainId: number;          // REQUIRED for TACo
    daoTokenType: 'ERC20' | 'ERC721';
  }
): EncryptMiddlewareHandle {
  // ... internals changed to use TacoKeyWrapper, interface unchanged
}
```

**Design Principle:** Preserve the Middleware contract so downstream consumers (`src/index.ts`) don't need major changes. Only constructor options differ.

---

## Implementation Details

### File: `src/middleware/encrypt.ts` (FULL REWRITE)

```typescript
/**
 * TACo (Threshold Access Control) Encryption Middleware
 * 
 * Replaces Lit Protocol v8 implementation with TACo DEVNET integration.
 * Provides identical middleware interface: AES-256-GCM encrypt responses,
 * threshold-encrypt AES key using configurable DAO token conditions.
 * 
 * Migration notes:
 * - Old Lit-encrypted data CANNOT be decrypted with this implementation
 * - Existing encryption metadata schema updated to taco-v1
 */

import * as crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from '../types';
import { createTacoKeyWrapper, TacoKeyMetadata } from '../utils/taco-key-wrapper';
import { DaoTokenConditionParams } from '../utils/taco-conditions';

// ─── Constants ────────────────────────────────────────────────

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;

// ─── Types ────────────────────────────────────────────────────

export interface TacoAccessControlCondition {
  contractAddress: string;
  standardContractType: string;
  chain: number;
  method: string;
  parameters: string[];
  returnValueTest: {
    comparator: string;
    value: string;
  };
}

export interface TacoEncryptionResult {
  ciphertext: string;       // Base64-encoded serialized messageKit
  dataToEncryptHash: string; // SHA-256 hex of AES key
}

export interface EncryptMiddlewareOptions {
  /** Key encryption function (now backed by TacoKeyWrapper) */
  litEncryptKey: (
    aesKey: Buffer,
    accessControlConditions: any[],
    chain: string
  ) => Promise<TacoEncryptionResult>;
  
  /** Optional decryption function (for session recovery) */
  litDecryptKey?: (
    ciphertext: string,
    dataToEncryptHash: string,
    accessControlConditions: any[],
    chain: string
  ) => Promise<Uint8Array>;
  
  /** Wallet address for access control (used as encryptor identity) */
  walletAddress: string;
  
  /** Chain name (e.g., "ethereum", "sepolia") */
  chain?: string;
  
  /** Path to persist encryption metadata JSON (enables shared key mode) */
  keyMetadataPath?: string;
  
  // ─── TACO-SPECIFIC (NEW) ────────────────────────────────────
  
  /** RPC URL for condition evaluation */
  tacoRpcUrl?: string;
  
  /** TACo ritual ID (default: 27 for DEVNET) */
  tacoRitualId?: number;
  
  /** DAO token contract address (REQUIRED) */
  daoContractAddress: string;
  
  /** DAO token chain ID (REQUIRED) */
  daoChainId: number;
  
  /** Token type: ERC20 or ERC721 */
  daoTokenType?: 'ERC20' | 'ERC721';
}

export interface EncryptionMetadata {
  version: "taco-v1";  // Updated from "hybrid-v1"
  encryptedKey: string;
  keyHash: string;
  algorithm: "AES-GCM";
  keyLength: number;
  ivLengthBytes: number;
  accessControlConditions: TacoAccessControlCondition[];
  chain: string;
  tacoDomain: string;         // NEW: "DEVNET"
  ritualId: number;           // NEW: e.g., 27
  metadataCid?: string;
}

// ─── AES Helpers (UNCHANGED from original) ────────────────────

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

// ─── Middleware Factory ───────────────────────────────────────

export function createEncryptMiddleware(
  options: EncryptMiddlewareOptions
): EncryptMiddlewareHandle {
  const { walletAddress, chain = 'ethereum' } = options;
  
  // Initialize TacoKeyWrapper
  const tacoWrapper = createTacoKeyWrapper({
    privateKey: process.env.WALLET_PRIVATE_KEY,
  });
  
  // State
  let cachedAESKey: Buffer | null = null;
  let cachedEncryptionResult: TacoEncryptionResult | null = null;
  let cachedACCs: TacoAccessControlCondition[] | null = null;
  
  // Build DAO condition for ACCs
  const buildACCs = (): TacoAccessControlCondition[] => {
    return [
      {
        contractAddress: options.daoContractAddress.toLowerCase(),
        standardContractType: options.daoTokenType ?? 'ERC20',
        chain: options.daoChainId,
        method: 'balanceOf',
        parameters: [':userAddress'],
        returnValueTest: {
          comparator: '>',
          value: '0',
        },
      },
    ];
  };
  
  async function getDaoCondition(): Promise<any> {
    const { buildDaoCondition } = await import('../utils/taco-conditions');
    return buildDaoCondition({
      chain: options.daoChainId,
      contractAddress: options.daoContractAddress,
      tokenType: options.daoTokenType ?? 'ERC20',
      minimumBalance: '1',
    });
  }
  
  const initialize = async (): Promise<void> => {
    console.log('[encrypt-taco] Initializing TACo encryption middleware...');
    
    cachedACCs = buildACCs();
    
    // Shared key mode: try to recover persisted key
    if (options.keyMetadataPath && fs.existsSync(options.keyMetadataPath)) {
      if (!options.litDecryptKey) {
        throw new Error(
          '[encrypt-taco] litDecryptKey required when recovering from metadata file'
        );
      }
      
      console.log('[encrypt-taco] Recovering key from', options.keyMetadataPath);
      
      const persisted: TacoKeyMetadata = JSON.parse(
        fs.readFileSync(options.keyMetadataPath, 'utf-8')
      );
      
      // Validate schema version
      if (persisted.version !== 'taco-v1') {
        throw new Error(
          `[encrypt-taco] Unsupported metadata version: ${persisted.version}. Expected taco-v1.`
        );
      }
      
      const decrypted = await options.litDecryptKey(
        persisted.encryptedKey,
        persisted.keyHash,
        persisted.accessControlConditions,
        persisted.chain
      );
      
      if (decrypted.length !== AES_KEY_BYTES) {
        throw new Error(
          `[encrypt-taco] Recovered key is ${decrypted.length} bytes, expected ${AES_KEY_BYTES}`
        );
      }
      
      const recoveredKey = Buffer.from(decrypted);
      const recoveredHash = sha256Hex(recoveredKey);
      if (recoveredHash !== persisted.keyHash) {
        throw new Error('[encrypt-taco] Key hash mismatch');
      }
      
      cachedAESKey = recoveredKey;
      cachedEncryptionResult = {
        ciphertext: persisted.encryptedKey,
        dataToEncryptHash: persisted.keyHash,
      };
      
      console.log('[encrypt-taco] AES key recovered from TACo');
      return;
    }
    
    // Generate new key
    cachedAESKey = tacoWrapper.generateAESKey();
    const daoCondition = await getDaoCondition();
    
    // Need signer for encryption (use env private key or fail)
    const privKey = process.env.WALLET_PRIVATE_KEY;
    if (!privKey) {
      throw new Error('[encrypt-taco] WALLET_PRIVATE_KEY required for encryption');
    }
    const { ethers } = await import('ethers');
    const provider = new ethers.providers.JsonRpcProvider(
      options.tacoRpcUrl || 'https://ethereum-rpc.publicnode.com'
    );
    const signer = new ethers.Wallet(privKey, provider);
    
    cachedEncryptionResult = await options.litEncryptKey(
      cachedAESKey,
      cachedACCs,
      chain
    );
    
    console.log('[encrypt-taco] AES key generated and wrapped via TACo');
    
    // Persist key metadata if path provided
    if (options.keyMetadataPath) {
      const metadata = getSessionMetadata();
      const dir = path.dirname(options.keyMetadataPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.keyMetadataPath,
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );
      console.log('[encrypt-taco] Key metadata persisted to', options.keyMetadataPath);
    }
  };
  
  const destroy = (): void => {
    if (cachedAESKey) {
      cachedAESKey.fill(0);
      cachedAESKey = null;
    }
    cachedEncryptionResult = null;
    cachedACCs = null;
  };
  
  const middleware: Middleware = {
    name: 'encrypt-taco',
    
    async onRequest(payload: RequestPayload, next: NextFunction): Promise<void> {
      if (!payload.context.metadata.capturedRequest) {
        payload.context.metadata.capturedRequest = payload.openaiRequest;
      }
      await next();
    },
    
    async onResponse(payload: ResponsePayload, next: NextFunction): Promise<void> {
      if (!cachedAESKey || !cachedEncryptionResult || !cachedACCs) {
        throw new Error(
          '[encrypt-taco] middleware not initialised — call initialize() first'
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
      const originalHash = sha256Hex(plaintext);
      
      const iv = generateIV();
      const { ciphertext, authTag } = aesEncrypt(plaintext, cachedAESKey, iv);
      const encryptedBuffer = Buffer.concat([iv, ciphertext, authTag]);
      
      payload.context.metadata.encryptedBuffer = encryptedBuffer;
      
      console.log(
        `[encrypt-taco] ${payload.context.requestId} | ${originalSize} → ${encryptedBuffer.length} bytes`
      );
      
      await next();
    },
  };
  
  const getSessionMetadata = (): EncryptionMetadata => {
    if (!cachedEncryptionResult || !cachedACCs) {
      throw new Error('[encrypt-taco] middleware not initialised');
    }
    return {
      version: 'taco-v1',
      encryptedKey: cachedEncryptionResult.ciphertext,
      keyHash: cachedEncryptionResult.dataToEncryptHash,
      algorithm: 'AES-GCM',
      keyLength: 256,
      ivLengthBytes: 12,
      accessControlConditions: cachedACCs,
      chain: chain,
      tacoDomain: 'DEVNET',
      ritualId: options.tacoRitualId ?? 27,
      metadataCid: undefined,  // Set by upload middleware if enabled
    };
  };
  
  return { middleware, initialize, getSessionMetadata, destroy };
}
```

---

## Changes Summary vs. Original

| Component | Before (Lit v8) | After (TACo) |
|-----------|-----------------|--------------|
| Key wrapping SDK | `@lit-protocol/lit-client` | `@nucypher/taco` |
| Init flow | `createLitClient({ network })` | `initialize()` + `domains.DEVNET` |
| ACC structure | Unified ACC array | `ContractCondition` class |
| Namespace in logs | `[encrypt]` | `[encrypt-taco]` |
| Metadata version | `"hybrid-v1"` | `"taco-v1"` |
| Required opts | `walletAddress`, `chain` | Also requires `daoContractAddress`, `daoChainId` |

---

## Testing Plan

### Unit Test: Middleware Lifecycle

```typescript
// tests/taco/middleware.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEncryptMiddleware } from '../../src/middleware/encrypt';
import fs from 'fs';

describe('TacoEncryptMiddleware', () => {
  let handle: ReturnType<typeof createEncryptMiddleware>;
  
  beforeEach(() => {
    handle = createEncryptMiddleware({
      litEncryptKey: async (_key, _accs, _chain) => ({
        ciphertext: 'mock-ciphertext',
        dataToEncryptHash: 'mock-hash',
      }),
      walletAddress: '0xTestWallet',
      chain: 'testnet',
      daoContractAddress: '0xDAO...',
      daoChainId: 1,
      daoTokenType: 'ERC20',
    });
  });
  
  afterEach(() => {
    handle.destroy();
  });
  
  it('should throw if initialize() not called', async () => {
    // Simulate request without initialization
    await expect(() => 
      handle.middleware.onResponse!(
        {} as any,
        async () => {}
      )
    ).rejects.toThrow('not initialised');
  });
  
  it.skip('should encrypt successfully after initialize()', async () => {
    // Requires actual TACo setup—manual test
    await handle.initialize();
    // ... send mock request
  });
});
```

---

## Dependencies

- Depends on S2-T2 (uses `TacoKeyWrapper`)
- Blocks S2-T4 through S2-T6
- Will be referenced by frontend tasks (Sprint 3) for decryption spec alignment

---

## Success Metrics

- ✅ Same interface as original (drop-in replacement for `index.ts`)
- ✅ Logging namespace updated for clarity
- ✅ Metadata schema includes TACo-specific fields
- ✅ Session recovery validates version compatibility
- ✅ Compilation succeeds with no type errors

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 3-4 of Sprint 2
