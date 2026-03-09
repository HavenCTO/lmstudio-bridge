# S1-T4: Client-Side Encryption Function (TACo → messageKit → IPFS)

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** S1-T1, S1-T2, S1-T3  
**Acceptance Criteria:**
- [ ] `tacoEncrypt()` function takes plaintext and DAO condition, returns messageKit
- [ ] messageKit wrapped in JSON with metadata (ritualId, domain, condition summary)
- [ ] Wrapped object uploadable to IPFS via `ipfs.add()` (compatible with Pinata/Web3.Storage)
- [ ] Unit tests verify round-trip encryption/serialization without actual network
- [ ] Integration test validates full flow against DEVNET (if available)

---

## Technical Specification

### TACo Encryption Overview

```typescript
import { initialize, encrypt, domains } from '@nucypher/taco';

await initialize();

const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
const signer = provider.getSigner(walletAddress);

// Encrypt data bound to conditions
const messageKit = await encrypt(
  provider,           // Provider for on-chain operations
  domains.DEVNET,     // TACo domain
  'secret message',   // Plaintext (string or Uint8Array)
  daoCondition,       // Condition returned by buildDaoCondition()
  ritualId,          // e.g., 27 for DEVNET
  signer             // For sign-in proof (encryptor authentication)
);
```

### messageKit Structure

The `messageKit` is an opaque object containing:
- Encrypted data (ciphertext)
- Condition metadata
- Ritual identification
- TACo protocol-specific fields

It's designed to be **storage-agnostic**: you can serialize it and store anywhere (IPFS, database, S3).

### IPFS Wrapper Schema

Since TACo doesn't mandate storage format, we wrap messageKit as JSON:

```json
{
  "schemaVersion": "taco-v1",
  "tacoDomain": "DEVNET",
  "ritualId": 27,
  "encryptionTimestamp": 1710000000,
  "conditionType": "ERC20Balance",
  "chainId": 1,
  "contractAddress": "0x...",
  "minBalance": "1",
  "messageKit": <serialized messageKit blob>,
  "metadataHash": "sha256:..."
}
```

**Note on serialization:** messageKit may contain UintBuffers that need base64 encoding before JSON.stringify.

---

## Implementation Details

### File: `src/utils/taco-encryption.ts`

```typescript
/**
 * TACo Encryption Utilities
 * 
 * Handles:
 * - Data encryption with conditions
 * - messageKit serialization
 * - IPFS wrapper creation
 * - Upload orchestration
 */

import { encrypt, domains } from '@nucypher/taco';
import { providers } from 'ethers';
import { buildDaoCondition, DaoTokenConditionParams } from './taco-conditions';

// Import type-safe if possible, else any
type MessageKit = any;

export interface TacoEncryptionParams {
  /** RPC provider for reading token balances */
  provider: providers.Provider | string;
  
  /** Wallet address of encryptor (must have signing capability) */
  signerAddress: string;
  
  /** Signer instance (needed for SIWE during encryption) */
  signer: providers.Signer;
  
  /** Plaintext to encrypt (string or Buffer/Uint8Array) */
  plaintext: string | Buffer | Uint8Array;
  
  /** DAO token condition parameters */
  daoCondition: DaoTokenConditionParams;
  
  /** TACo ritual ID (default: 27 for DEVNET) */
  ritualId?: number;
}

export interface TacoMessageWrapper {
  schemaVersion: string;
  tacoDomain: string;
  ritualId: number;
  encryptionTimestamp: number;
  conditionType: string;
  chainId: number;
  contractAddress: string;
  minBalance: string;
  messageKit: MessageKit; // After serialization
  metadataHash?: string;
}

/**
 * Convert messageKit to JSON-serializable format
 * 
 * messageKit contains Uint8Arrays and nested objects; we need to ensure
 * everything can survive JSON.stringify -> JSON.parse
 */
function serializeMessageKit(messageKit: MessageKit): Record<string, unknown> {
  return JSON.parse(JSON.stringify(messageKit, (key, value) => {
    if (value instanceof Uint8Array) {
      return {
        __type: 'Uint8Array',
        data: Array.from(value),
      };
    }
    if (value instanceof Buffer) {
      return {
        __type: 'Buffer',
        data: Array.from(value),
      };
    }
    return value;
  }));
}

/**
 * Deserialize messageKit back to original form
 */
function deserializeMessageKit(serialized: Record<string, unknown>): MessageKit {
  return JSON.parse(JSON.stringify(serialized), (key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
      return new Uint8Array((value as any).data);
    }
    if (value && typeof value === 'object' && value.__type === 'Buffer') {
      return Buffer.from((value as any).data);
    }
    return value;
  });
}

/**
 * Encrypt data with TACo using DAO token conditions
 */
export async function tacoEncrypt(params: TacoEncryptionParams): Promise<MessageKit> {
  const provider = typeof params.provider === 'string'
    ? new providers.JsonRpcProvider(params.provider)
    : params.provider;
  
  try {
    console.log('[taco] Encrypting data with ritualId=%d...', params.ritualId ?? 27);
    
    // Build condition
    const condition = buildDaoCondition(params.daoCondition);
    
    // Perform encryption
    const messageKit = await encrypt(
      provider,
      domains.DEVNET,
      params.plaintext,
      condition,
      params.ritualId ?? 27,
      params.signer
    );
    
    console.log('[taco] Encryption successful');
    return messageKit;
    
  } catch (error) {
    console.error('[taco] Encryption failed:', error);
    throw new Error(
      `[taco] Encryption failed. Check: (1) ritualId is valid for domain, ` +
      `(2) signer is properly authenticated, (3) RPC connection stable. ` +
      `Error: ${error instanceof Error ? error.message : error}`
    );
  }
}

/**
 * Create IPFS-ready wrapper around messageKit
 */
export function createIpfsWrapper(
  messageKit: MessageKit,
  daoCondition: DaoTokenConditionParams
): TacoMessageWrapper {
  // Compute content hash for integrity verification
  const crypto = require('crypto');
  const rawData = JSON.stringify({
    ...daoCondition,
    timestamp: Date.now(),
  });
  const metadataHash = `sha256:${crypto.createHash('sha256').update(rawData).digest('hex')}`;
  
  return {
    schemaVersion: 'taco-v1',
    tacoDomain: 'DEVNET',
    ritualId: 27,
    encryptionTimestamp: Math.floor(Date.now() / 1000),
    conditionType: daoCondition.tokenType,
    chainId: daoCondition.chain,
    contractAddress: daoCondition.contractAddress,
    minBalance: daoCondition.minimumBalance ?? '1',
    messageKit: serializeMessageKit(messageKit),
    metadataHash,
  };
}

/**
 * Upload wrapper object to IPFS
 * 
 * Uses Web3.Storage/Pinata-compatible API. Accepts:
 * - ipfsHost: Base URL (e.g., 'https://api.pinata.cloud')
 * - ipfsApiKey: API key
 * - ipfsSecret: API secret
 */
export async function uploadToIpfs(
  wrapper: TacoMessageWrapper,
  options: {
    ipfsHost: string;
    apiKey: string;
    secretKey?: string;
  }
): Promise<{ cid: string; url: string }> {
  const crypto = await import('crypto');
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  
  // Serialize to JSON file
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `taco-${Date.now()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(wrapper, null, 2), 'utf-8');
  
  try {
    // Pinata-style upload (adjust for your IPFS provider)
    const formData = new (require('form-data'))();
    formData.append('file', fs.createReadStream(tempFile));
    
    const response = await fetch(`${options.ipfsHost}/upload/v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.apiKey}`,
        ...(options.secretKey ? { 'pinata_secret_api_key': options.secretKey } : {}),
      },
      body: formData,
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`IPFS upload failed: ${response.status} ${errText}`);
    }
    
    const result = await response.json();
    const cid = result.IpfsHash || result.cid;
    
    console.log(`[taco] Uploaded to IPFS: CID=${cid}`);
    
    return {
      cid,
      url: `https://ipfs.io/ipfs/${cid}`,
    };
    
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(tempFile); } catch (_) {}
  }
}

/**
 * End-to-end encryption + upload helper
 */
export async function tacoEncryptAndUpload(
  encryptParams: TacoEncryptionParams,
  ipfsOptions: { ipfsHost: string; apiKey: string; secretKey?: string }
): Promise<{ cid: string; url: string; wrapper: TacoMessageWrapper }> {
  const messageKit = await tacoEncrypt(encryptParams);
  const wrapper = createIpfsWrapper(messageKit, encryptParams.daoCondition);
  const { cid, url } = await uploadToIpfs(wrapper, ipfsOptions);
  
  return { cid, url, wrapper };
}
```

---

## Usage Example

```typescript
import { providers } from 'ethers';
import { tacoEncryptAndUpload } from './utils/taco-encryption';

async function main() {
  const provider = new providers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
  const wallet = new providers.Wallet(process.env.ENCRYPTOR_PRIVATE_KEY!, provider);
  
  const result = await tacoEncryptAndUpload(
    {
      provider,
      signerAddress: await wallet.getAddress(),
      signer: wallet,
      plaintext: 'This is a secret message for DAO holders',
      daoCondition: {
        chain: 1,
        contractAddress: '0xYourDAO...',
        tokenType: 'ERC20',
        minimumBalance: '1',
      },
      ritualId: 27,
    },
    {
      ipfsHost: 'https://api.pinata.cloud',
      apiKey: process.env.PINATA_API_KEY!,
      secretKey: process.env.PINATA_SECRET_KEY!,
    }
  );
  
  console.log('Encrypted and uploaded!');
  console.log('CID:', result.cid);
  console.log('URL:', result.url);
}
```

---

## Testing Plan

### Unit Test: Serialization
```typescript
// tests/taco/encryption.test.ts
import { describe, it, expect } from 'vitest';
import { serializeMessageKit, deserializeMessageKit } from '../../src/utils/taco-encryption';

describe('messageKit Serialization', () => {
  it('should round-trip Uint8Array through JSON', () => {
    const mockMessageKit = {
      ciphertext: new Uint8Array([1, 2, 3, 4]),
      otherField: 'test',
    };
    
    const serialized = serializeMessageKit(mockMessageKit);
    const deserialized = deserializeMessageKit(serialized as any);
    
    expect(deserialized.ciphertext).toBeInstanceOf(Uint8Array);
    expect(Array.from(deserialized.ciphertext)).toEqual([1, 2, 3, 4]);
  });
});
```

### Integration Test: Full Flow (Mocked Providers)
```javascript
// tests/taco/encryption-integration.test.js
// Note: This requires actual TACO DEVNET access; skip in CI unless configured

const { tacoEncrypt, createIpfsWrapper } = require('../../dist/utils/taco-encryption');

async function runTest() {
  // Only run if credentials provided
  if (!process.env.TACO_INTEGRATION_TEST) {
    console.log('⊘ Skipping integration test (set TACO_INTEGRATION_TEST=1 to enable)');
    return;
  }
  
  console.log('Running full encryption integration test...');
  // ... implement with real RPC, real wallet, etc.
}

runTest();
```

---

## Dependencies
- Blocks S1-T5 (decryption needs matching serialization format)
- Depends on S1-T3 (uses buildDaoCondition())

---

## Success Metrics
- ✅ messageKit serializes without data loss
- ✅ Wrapper includes all required metadata fields
- ✅ IPFS upload succeeds when credentials provided
- ✅ Tests pass in local dev environment

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 5-6 of Sprint 1
