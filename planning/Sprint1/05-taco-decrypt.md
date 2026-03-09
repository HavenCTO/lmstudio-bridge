# S1-T5: Client-Side Decryption Function (IPFS → messageKit → ConditionContext → decrypt)

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** S1-T1, S1-T2, S1-T3, S1-T4  
**Acceptance Criteria:**
- [ ] `tacoDecrypt()` fetches wrapper from IPFS, deserializes messageKit
- [ ] ConditionContext created from messageKit
- [ ] EIP4361AuthProvider added for :userAddress context variable
- [ ] Decryption succeeds for valid DAO token holder
- [ ] Decryption fails with clear error for non-holder
- [ ] Unit tests cover serialization/deserialization edge cases

---

## Technical Specification

### TACo Decryption Overview

```typescript
import { decrypt, domains, initialize } from '@nucypher/taco';
import { conditions } from '@nucypher/taco';
import { EIP4361AuthProvider, USER_ADDRESS_PARAM_DEFAULT } from '@nucypher/taco-auth';

await initialize();

const provider = new ethers.providers.Web3Provider(window.ethereum);
const signer = provider.getSigner();

// 1. Fetch messageKit from storage (IPFS in our case)
const wrappedData = await fetchFromIpfs(cid);
const messageKit = deserializeMessageKit(wrappedData.messageKit);

// 2. Create ConditionContext from messageKit
const conditionContext = conditions.context.ConditionContext.fromMessageKit(messageKit);

// 3. Add auth provider for :userAddress verification
const authProvider = new EIP4361AuthProvider(provider, signer);
conditionContext.addAuthProvider(USER_ADDRESS_PARAM_DEFAULT, authProvider);

// 4. Decrypt
const decryptedBytes = await decrypt(
  provider,
  domains.DEVNET,
  messageKit,
  conditionContext
);

// 5. Convert from Uint8Array to string
const plaintext = new TextDecoder().decode(decryptedBytes);
```

### Authentication Flow

When the condition contains `:userAddress`, TACo nodes need proof that the requester owns that address. `EIP4361AuthProvider` handles this by prompting a SIWE signature:

1. User clicks "Decrypt" button
2. Provider shows wallet signature prompt (or uses existing session)
3. Signature cached for subsequent requests (2-hour expiry)
4. TACo nodes verify signature, evaluate `balanceOf(userAddress)` against on-chain state

---

## Implementation Details

### File: `src/utils/taco-decryption.ts`

```typescript
/**
 * TACo Decryption Utilities
 * 
 * Handles:
 * - Fetching messageKit from IPFS
 * - Deserialization
 * - ConditionContext setup
 * - Auth provider management
 * - Decryption orchestration
 */

import { decrypt, domains, initialize } from '@nucypher/taco';
import { conditions } from '@nucypher/taco';
import { EIP4361AuthProvider, USER_ADDRESS_PARAM_DEFAULT } from '@nucypher/taco-auth';
import { providers } from 'ethers';
import { TacoMessageWrapper } from './taco-encryption';
import { deserializeMessageKit } from './taco-encryption';

export interface TacoDecryptionResult {
  plaintext: string;
  originalCondition: {
    chainId: number;
    contractAddress: string;
    tokenType: string;
  };
}

export interface TacoDecryptError {
  code: 'AUTH_FAILED' | 'CONDITION_NOT_MET' | 'NETWORK_ERROR' | 'INVALID_MESSAGEKIT' | 'UNKNOWN';
  message: string;
  details?: unknown;
}

let tacoInitialized = false;

/**
 * Ensure TACo SDK is initialized
 */
async function ensureTacoInitialized(): Promise<void> {
  if (!tacoInitialized) {
    await initialize();
    tacoInitialized = true;
  }
}

/**
 * Fetch wrapper from IPFS
 */
async function fetchFromIpfs(
  cid: string,
  options?: { gatewayUrl?: string }
): Promise<TacoMessageWrapper> {
  const gateway = options?.gatewayUrl ?? 'https://ipfs.io';
  const url = `${gateway}/ipfs/${cid}`;
  
  try {
    const response = await fetch(url, { timeout: 10000 });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Basic validation
    if (!data.schemaVersion || !data.messageKit) {
      throw new Error('Invalid wrapper format: missing required fields');
    }
    
    return data as TacoMessageWrapper;
    
  } catch (error) {
    console.error('[taco] Failed to fetch from IPFS:', error);
    throw new TacoDecryptError({
      code: 'NETWORK_ERROR',
      message: `Failed to fetch IPFS content: ${error instanceof Error ? error.message : error}`,
    });
  }
}

/**
 * Perform TACo decryption
 */
export async function tacoDecrypt(
  ipfsCid: string,
  provider: providers.Provider | string,
  signer: providers.Signer,
  options?: {
    ipfsGateway?: string;
    skipAuthVerification?: boolean;
  }
): Promise<TacoDecryptionResult> {
  await ensureTacoInitialized();
  
  const web3Provider = typeof provider === 'string'
    ? new providers.JsonRpcProvider(provider)
    : provider;
  
  try {
    console.log('[taco] Starting decryption for CID:', ipfsCid);
    
    // 1. Fetch wrapper from IPFS
    const wrapper = await fetchFromIpfs(ipfsCid, { gatewayUrl: options?.ipfsGateway });
    
    // 2. Deserialize messageKit
    const messageKit = deserializeMessageKit(wrapper.messageKit);
    
    // 3. Extract user address from signer
    const userAddress = await signer.getAddress();
    
    // 4. Create ConditionContext
    const conditionContext = conditions.context.ConditionContext.fromMessageKit(messageKit);
    
    // 5. Add auth provider for :userAddress (REQUIRED for dynamic conditions)
    const authProvider = new EIP4361AuthProvider(web3Provider, signer);
    conditionContext.addAuthProvider(USER_ADDRESS_PARAM_DEFAULT, authProvider);
    
    // Check if there are custom context variables needed
    if (conditionContext.requestedContextParameters.has(':selectedBalance')) {
      // This would be set by the encryptor; we use default or provided value
      conditionContext.addCustomContextParameterValues({
        ':selectedBalance': wrapper.minBalance || '1',
      });
    }
    
    // 6. Perform decryption
    console.log('[taco] Requesting decryption fragments...');
    const decryptedBytes = await decrypt(
      web3Provider,
      domains.DEVNET,
      messageKit,
      conditionContext
    );
    
    // 7. Convert to string
    const plaintext = new TextDecoder().decode(decryptedBytes);
    
    console.log('[taco] Decryption successful');
    
    return {
      plaintext,
      originalCondition: {
        chainId: wrapper.chainId,
        contractAddress: wrapper.contractAddress,
        tokenType: wrapper.conditionType,
      },
    };
    
  } catch (error) {
    console.error('[taco] Decryption failed:', error);
    
    // Classify error
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    let errorCode: TacoDecryptError['code'] = 'UNKNOWN';
    
    if (errorMessage.toLowerCase().includes('authentication') || 
        errorMessage.toLowerCase().includes('signature')) {
      errorCode = 'AUTH_FAILED';
    } else if (errorMessage.toLowerCase().includes('condition') || 
               errorMessage.toLowerCase().includes('not met')) {
      errorCode = 'CONDITION_NOT_MET';
    } else if (errorMessage.toLowerCase().includes('invalid') ||
               errorMessage.toLowerCase().includes('malformed')) {
      errorCode = 'INVALID_MESSAGEKIT';
    }
    
    throw {
      code: errorCode,
      message: errorMessage,
      details: error,
    } as TacoDecryptError;
  }
}

/**
 * Lightweight check: can this wallet decrypt without actually decrypting?
 * 
 * Useful for UX: show "locked/unlocked" status before user clicks to decrypt
 */
export async function canDecrypt(
  ipfsCid: string,
  provider: providers.Provider | string
): Promise<{ canDecrypt: boolean; reason?: string }> {
  try {
    const web3Provider = typeof provider === 'string'
      ? new providers.JsonRpcProvider(provider)
      : provider;
    
    // Fetch wrapper
    const wrapper = await fetchFromIpfs(ipfsCid);
    
    console.log('[taco] Decryption target requires:', {
      chainId: wrapper.chainId,
      contract: wrapper.contractAddress,
      tokenType: wrapper.conditionType,
      minBalance: wrapper.minBalance,
    });
    
    // Return analysis (actual decryption attempt deferred)
    return {
      canDecrypt: true, // We don't know yet without attempting
      reason: `Requires ${wrapper.tokenType} holder (${wrapper.contractAddress})`,
    };
    
  } catch (error) {
    return {
      canDecrypt: false,
      reason: `Unable to analyze: ${error instanceof Error ? error.message : error}`,
    };
  }
}

/**
 * Cache management for authentication signatures
 * 
 * Note: TACo SDK handles caching internally; this is for logging/debugging
 */
export interface CachedAuthInfo {
  lastSignatureTime: number;
  expiresAt: number;  // Unix timestamp
  walletAddress: string;
}

const authCache = new Map<string, CachedAuthInfo>();

export function cacheAuthSignature(
  walletAddress: string,
  signature: Buffer | Uint8Array
): void {
  const expiresAt = Date.now() + (2 * 60 * 60 * 1000); // 2 hours like SIWE
  authCache.set(walletAddress, {
    lastSignatureTime: Date.now(),
    expiresAt,
    walletAddress,
  });
}

export function getCachedAuthExpiry(walletAddress: string): number | undefined {
  const cached = authCache.get(walletAddress);
  return cached?.expiresAt;
}

export function clearCachedAuth(walletAddress?: string): void {
  if (walletAddress) {
    authCache.delete(walletAddress);
  } else {
    authCache.clear();
  }
}
```

---

## Usage Example

```typescript
import { Wallet, providers } from 'ethers';
import { tacoDecrypt } from './utils/taco-decryption';

async function main() {
  // Setup signer (must be DAO token holder)
  const provider = new providers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
  const wallet = new Wallet(process.env.DECRYPTOR_PRIVATE_KEY!, provider);
  
  // IPFS CID of encrypted content
  const cid = 'QmYourCidfHere...';
  
  try {
    const result = await tacoDecrypt(cid, provider, wallet);
    
    console.log('✅ Decryption successful!');
    console.log('Plaintext:', result.plaintext);
    console.log('Original condition:', {
      chain: result.originalCondition.chainId,
      contract: result.originalCondition.contractAddress,
      type: result.originalCondition.tokenType,
    });
    
  } catch (error: any) {
    console.error('❌ Decryption failed:');
    console.error('  Code:', error.code);
    console.error('  Message:', error.message);
    
    if (error.code === 'CONDITION_NOT_MET') {
      console.warn('\nHint: Your wallet does not hold the required DAO tokens.');
      console.warn('Check balance at:', `https://etherscan.io/token/${error.contractAddress}`);
    }
  }
}
```

---

## Testing Plan

### Unit Test: Deserialization
```typescript
// tests/taco/decryption.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { deserializeMessageKit } from '../../src/utils/taco-encryption';

describe('tacoDecrypt helpers', () => {
  it('should reconstruct Uint8Array from serialized format', () => {
    const rawMessageKit = {
      ciphertext: new Uint8Array([10, 20, 30]),
      metadata: { foo: 'bar' },
    };
    
    const json = JSON.parse(JSON.stringify(rawMessageKit, (k, v) =>
      v instanceof Uint8Array ? { __type: 'Uint8Array', data: Array.from(v) } : v
    ));
    
    const restored = deserializeMessageKit(json);
    expect(restored.ciphertext).toBeInstanceOf(Uint8Array);
    expect(restored.metadata.foo).toBe('bar');
  });
});
```

### Integration Test: Success Path
```javascript
// tests/taco/decryption-success.test.js
// Requires actual TACO DEVNET setup + DAO token holder wallet

const { tacoDecrypt } = require('../../dist/utils/taco-decryption');

const TEST_CID = process.env.TEST_TACO_CID;
const TEST_PRIVATE_KEY = process.env.TEST_DECRYPTOR_KEY;

async function testDecryption() {
  if (!TEST_CID || !TEST_PRIVATE_KEY) {
    console.log('Skipping; set TEST_TACO_CID and TEST_DECRYPTOR_KEY');
    return;
  }
  
  const wallet = new (require('ethers')).Wallet(TEST_PRIVATE_KEY);
  const result = await tacoDecrypt(TEST_CID, wallet.provider, wallet);
  
  console.assert(result.plaintext, 'Expected plaintext result');
  console.log('✅ Decryption succeeded:', result.plaintext.substring(0, 50));
}
```

### Integration Test: Failure Path (Non-Holder)
```javascript
// tests/taco/decryption-failure.test.js
// Uses empty wallet (no tokens) → should fail

async function testDecryptionFailure() {
  const emptyWallet = new (require('ethers')).Wallet(require('ethers').randomBytes(32));
  
  try {
    await tacoDecrypt(TEST_CID, emptyWallet.provider, emptyWallet);
    console.error('❌ Expected failure but decryption succeeded!');
    process.exit(1);
  } catch (err) {
    if (err.code === 'CONDITION_NOT_MET') {
      console.log('✅ Correctly rejected non-holder:', err.message);
    } else {
      console.error('❓ Unexpected error code:', err.code);
    }
  }
}
```

---

## Error Codes Reference

| Code | Cause | User-Facing Message |
|------|-------|---------------------|
| AUTH_FAILED | Invalid/wrong signature | "Authentication failed. Please sign the message again." |
| CONDITION_NOT_MET | User has no tokens | "You do not hold the required DAO tokens to access this content." |
| NETWORK_ERROR | IPFS/RPC unreachable | "Network error. Please check your connection and try again." |
| INVALID_MESSAGEKIT | Corrupted/malformed data | "Encrypted data is corrupted. Contact the content owner." |
| UNKNOWN | Unexpected failure | "An unexpected error occurred. Please try again." |

---

## Dependencies
- Depends on S1-T4 (uses same serialization format)
- Unblocks frontend integration tasks (Sprint 3)

---

## Success Metrics
- ✅ Successfully decrypts TACo-encrypted content
- ✅ Rejects non-holders with clear error
- ✅ Proper auth flow (SIWE signature prompts correctly)
- ✅ Tests both success and failure paths

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 6-7 of Sprint 1
