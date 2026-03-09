# S2-T2: Implement TACo Key Encryption/Recovery Helper Class

**Owner:** Backend Engineer  
**Estimated Effort:** 1.5 days  
**Dependencies:** S2-T1 (Lit code archived), Sprint 1 utilities in place  
**Acceptance Criteria:**
- [ ] `TacoKeyWrapper` class created with `encrypt()` and `decrypt()` methods
- [ ] AES-256-GCM encryption/decryption preserved from original middleware
- [ ] messageKit lifecycle matches original (`ciphertext`, `dataToEncryptHash`)
- [ ] Key metadata JSON schema updated for TACo compatibility
- [ ] Unit tests verify encrypt → decrypt round-trip
- [ ] Session-state management (cache recovered keys)

---

## Technical Specification

### Original Lit v8 Pattern (for reference)

```typescript
// Old Lit implementation
const litResult = await litClient.encrypt({
  dataToEncrypt: aesKey,
  unifiedAccessControlConditions,
  chain,
});

// Output
{
  ciphertext: "<base64>",      // Encrypted AES key
  dataToEncryptHash: "<hex>",  // SHA-256 of raw AES key
}
```

### New TACo Pattern

```typescript
// TACo implementation
import { encrypt, domains } from '@nucypher/taco';

const messageKit = await encrypt(
  provider,
  domains.DEVNET,
  aesKey,              // Uint8Array or string
  daoCondition,        // ContractCondition
  ritualId,            // e.g., 27
  signer               // For encryptor auth
);

// messageKit is opaque but contains encrypted data + conditions
// We serialize it for storage/retrieval
```

### Key Differences

| Aspect | Lit v8 | TACo | Impact |
|--------|--------|------|--------|
| Encrypt output | `{ciphertext, dataToEncryptHash}` | `messageKit` object | Need serialization wrapper |
| Condition format | Unified ACC array | `ContractCondition` class | Use builder from S1-T3 |
| Auth requirement | `AuthManager.createEoaAuthContext()` | `Signer` passed to encrypt() | Similar flow, different API |
| Network config | `nagaDev` module | `domains.DEVNET` constant | Direct mapping |

---

## Implementation Details

### File: `src/utils/taco-key-wrapper.ts`

```typescript
/**
 * TACo Key Wrapping Utility
 * 
 * Replaces the Lit Protocol key encryption layer from src/middleware/encrypt.ts
 * Provides identical interface: encrypt AES key → recover AES key via threshold decryption
 */

import { encrypt, initialize, domains } from '@nucypher/taco';
import { conditions } from '@nucypher/taco';
import { providers, Wallet } from 'ethers';
import * as crypto from 'crypto';
import { buildDaoCondition, DaoTokenConditionParams } from './taco-conditions';

// ─── Types ──────────────────────────────────────────────────────

export interface TacoEncryptionResult {
  /** Serialized messageKit (JSON-safe after serialization) */
  ciphertext: string;
  
  /** Hash of the plaintext (AES key) for integrity verification */
  dataToEncryptHash: string;
  
  /** Raw messageKit object (not serialized) - keep in memory only */
  _messageKit?: unknown;
}

export interface TacoKeyMetadata {
  version: "taco-v1";
  encryptedKey: string;    // Base64-encoded serialized messageKit
  keyHash: string;         // SHA-256 hex of AES key
  algorithm: "AES-GCM";
  keyLength: number;       // 256
  accessControlConditions: any[];  // Condition JSON
  chain: string;           // Chain ID used
  tacoDomain: string;      // "DEVNET"
  ritualId: number;        // e.g., 27
  metadataCid?: string;    // IPFS CID if uploaded
}

// ─── Constants ──────────────────────────────────────────────────

const AES_KEY_BYTES = 32;  // 256 bits

// ─── Main Class ─────────────────────────────────────────────────

export class TacoKeyWrapper {
  private initialized: boolean = false;
  private cachedProvider: providers.Provider | null = null;
  
  constructor(
    private readonly options: {
      rpcUrl?: string;
      tacoDomain?: string;     // "DEVNET" | "TESTNET"
      ritualId?: number;
      privateKey?: string;     // For session recovery mode
    } = {}
  ) {}
  
  /**
   * Ensure TACo SDK is initialized
   */
  async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      console.log('[taco-writer] Initializing TACo SDK...');
      await initialize();
      this.initialized = true;
      console.log('[taco-writer] TACo SDK ready');
    }
  }
  
  /**
   * Get provider for current configuration
   */
  getProvider(): providers.Provider {
    if (!this.cachedProvider) {
      const rpcUrl = this.options.rpcUrl || 'https://ethereum-rpc.publicnode.com';
      this.cachedProvider = new providers.JsonRpcProvider(rpcUrl);
    }
    return this.cachedProvider;
  }
  
  /**
   * Generate a fresh AES-256 key
   */
  generateAESKey(): Buffer {
    return crypto.randomBytes(AES_KEY_BYTES);
  }
  
  /**
   * Compute SHA-256 hash of key (for integrity verification)
   */
  computeKeyHash(key: Buffer): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }
  
  /**
   * Encrypt an AES key using TACo threshold encryption
   * 
   * @param aesKey - 32-byte AES key to encrypt
   * @param daoCondition - DAO token condition parameters
   * @returns Encrypted result compatible with original Lit interface
   */
  async encrypt(
    aesKey: Buffer,
    daoCondition: DaoTokenConditionParams,
    signerAddress: string,
    signer: providers.Signer
  ): Promise<TacoEncryptionResult> {
    await this.ensureInitialized();
    
    try {
      console.log('[taco-writer] Encrypting key with TACo...');
      
      const provider = this.getProvider();
      const condition = buildDaoCondition(daoCondition);
      
      // Perform TACo encryption
      const messageKit = await encrypt(
        provider,
        domains.DEVNET,
        aesKey,
        condition,
        this.options.ritualId ?? 27,
        signer
      );
      
      // Serialize messageKit for storage
      const serialized = JSON.stringify(messageKit, (key, value) => {
        if (value instanceof Uint8Array || value instanceof Buffer) {
          return { __type: 'Buffer', data: Array.from(value) };
        }
        return value;
      });
      
      const encryptedKey = Buffer.from(serialized, 'utf-8').toString('base64');
      const keyHash = this.computeKeyHash(aesKey);
      
      console.log('[taco-writer] Key encrypted successfully');
      
      return {
        ciphertext: encryptedKey,
        dataToEncryptHash: keyHash,
        _messageKit: messageKit,  // Keep raw for potential in-memory reuse
      };
      
    } catch (error) {
      console.error('[taco-writer] Encryption failed:', error);
      throw new Error(
        `[taco-writer] Failed to encrypt key: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  
  /**
   * Decrypt/recover an AES key from TACo encrypted ciphertext
   * 
   * Note: Full decryption requires ConditionContext setup and SIWE auth
   * This method wraps the lower-level tacoDecrypt function
   */
  async decrypt(
    encryptionResult: Pick<TacoEncryptionResult, 'ciphertext' | 'dataToEncryptHash'>,
    signingWallet: Wallet
  ): Promise<Buffer> {
    // Delegate to taco-decryption.ts implementation
    const { tacoDecryptFromWrapped } = await import('./taco-decryption-extras');
    
    console.log('[taco-writer] Recovering key from TACo...');
    
    const plaintext = await tacoDecryptFromWrapped(
      encryptionResult,
      signingWallet
    );
    
    if (plaintext.length !== AES_KEY_BYTES) {
      throw new Error(
        `[taco-writer] Recovered key is ${plaintext.length} bytes, expected ${AES_KEY_BYTES}`
      );
    }
    
    const recoveredHash = this.computeKeyHash(plaintext);
    if (recoveredHash !== encryptionResult.dataToEncryptHash) {
      throw new Error('[taco-writer] Key hash mismatch after decryption');
    }
    
    console.log('[taco-writer] Key recovered successfully');
    
    return plaintext;
  }
  
  /**
   * Create metadata JSON for persistence
   */
  createMetadata(
    encryptionResult: TacoEncryptionResult,
    daoCondition: DaoTokenConditionParams
  ): TacoKeyMetadata {
    return {
      version: 'taco-v1',
      encryptedKey: encryptionResult.ciphertext,
      keyHash: encryptionResult.dataToEncryptHash,
      algorithm: 'AES-GCM',
      keyLength: 256,
      accessControlConditions: [daoCondition],  // Simplified for now
      chain: daoCondition.chain.toString(),
      tacoDomain: 'DEVNET',
      ritualId: this.options.ritualId ?? 27,
    };
  }
  
  /**
   * Disconnect and clean up resources
   */
  async disconnect(): Promise<void> {
    if (this.cachedProvider) {
      // No explicit cleanup needed for JSON-RPC provider
      this.cachedProvider = null;
    }
    this.initialized = false;
    console.log('[taco-writer] Disconnected');
  }
}

// ─── Factory Function (Compat with original API) ────────────────

export function createTacoKeyWrapper(options?: {
  network?: string;
  privateKey?: string;
  chain?: string;
}): {
  encrypt: TacoKeyWrapper['encrypt'];
  decrypt: TacoKeyWrapper['decrypt'];
  disconnect: TacoKeyWrapper['disconnect'];
  generateAESKey: TacoKeyWrapper['generateAESKey'];
  computeKeyHash: TacoKeyWrapper['computeKeyHash'];
  createMetadata: TacoKeyWrapper['createMetadata'];
} {
  const wrapper = new TacoKeyWrapper({
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    tacoDomain: 'DEVNET',
    ritualId: 27,
    privateKey: options?.privateKey,
  });
  
  return {
    encrypt: wrapper.encrypt.bind(wrapper),
    decrypt: wrapper.decrypt.bind(wrapper),
    disconnect: wrapper.disconnect.bind(wrapper),
    generateAESKey: wrapper.generateAESKey.bind(wrapper),
    computeKeyHash: wrapper.computeKeyHash.bind(wrapper),
    createMetadata: wrapper.createMetadata.bind(wrapper),
  };
}
```

---

## Usage Example (Middleware Integration)

```typescript
import { createTacoKeyWrapper } from './utils/taco-key-wrapper';

const tacoWrapper = createTacoKeyWrapper({
  privateKey: process.env.WALLET_PRIVATE_KEY,
});

// Encryption path
const aesKey = tacoWrapper.generateAESKey();
const encryptionResult = await tacoWrapper.encrypt(
  aesKey,
  {
    chain: 1,
    contractAddress: '0xDAO...',
    tokenType: 'ERC20',
  },
  '0xWalletAddress',
  walletSigner
);

const metadata = tacoWrapper.createMetadata(encryptionResult, {
  chain: 1,
  contractAddress: '0xDAO...',
  tokenType: 'ERC20',
});

fs.writeFileSync('./session-metadata.json', JSON.stringify(metadata));

// Decryption path (recover key for subsequent uses)
const persisted = JSON.parse(fs.readFileSync('./session-metadata.json', 'utf-8'));
const recoveredKey = await tacoWrapper.decrypt(
  { ciphertext: persisted.encryptedKey, dataToEncryptHash: persisted.keyHash },
  signingWallet
);
```

---

## Testing Plan

### Unit Test: Key Lifecycle

```typescript
// tests/taco/key-wrapper.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TACoKeyWrapper } from '../../src/utils/taco-key-wrapper';
import { Wallet } from 'ethers';

describe('TacoKeyWrapper', () => {
  let wrapper: TacoKeyWrapper;
  let testWallet: Wallet;
  
  beforeEach(() => {
    wrapper = new TacoKeyWrapper();
    testWallet = Wallet.createRandom();
  });
  
  it('should generate valid AES-256 key', () => {
    const key = wrapper.generateAESKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
  
  it('should produce consistent key hash', () => {
    const key = Buffer.alloc(32, 0x42);
    const hash1 = wrapper.computeKeyHash(key);
    const hash2 = wrapper.computeKeyHash(key);
    expect(hash1).toBe(hash2);
  });
  
  it.skip('should encrypt and decrypt key (requires TACo network)', async () => {
    // Marked as skip - requires DEVNET access
    // Run manually with TEST_TACO_INTEGRATION_TEST=1
    const aesKey = wrapper.generateAESKey();
    const result = await wrapper.encrypt(aesKey, {...}, '0x...', testWallet);
    
    const recovered = await wrapper.decrypt(result, testWallet);
    expect(recovered.equals(aesKey)).toBe(true);
  });
});
```

---

## Dependencies

- Depends on S1-T3 (uses `buildDaoCondition`)
- Unblocks S2-T3 (middleware can use this wrapper)
- Blocks S2-T4 through S2-T6

---

## Success Metrics

- ✅ Interface matches original Lit wrapper (`encrypt()`, `decrypt()`)
- ✅ Key generation/hashing unchanged (AES-GCM still used)
- ✅ Serialization/deserialization preserves all fields
- ✅ Tests pass without network dependency (unit level)

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 2 of Sprint 2
