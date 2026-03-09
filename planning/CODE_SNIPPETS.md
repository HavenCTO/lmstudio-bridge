# TACo Code Snippets & Artifacts

This document contains runnable TypeScript snippets for TACo encryption/decryption flows referenced throughout the migration plan.

---

## 1. TACo Encryption Snippet (Client-Side)

Creates DAO token-holder condition, encrypts data, stores messageKit on IPFS.

### Dependencies
```bash
npm install @nucypher/taco@devnet @nucypher/taco-auth ethers@5.7.2
```

### Full Example: `taco-encrypt.ts`

```typescript
/**
 * TACo Client-Side Encryption Demo
 * 
 * Encrypts a secret message with DAO token-holding condition
 * and uploads the encrypted payload to IPFS.
 * 
 * Prerequisites:
 * - TACo DEVNET ritualId=27 is active
 * - You have a wallet with signing capability (can be any address for dev)
 * - Dao token contract exists (any ERC20/ERC721)
 */

import { initialize, encrypt, conditions, domains } from '@nucypher/taco';
import { providers, Wallet } from 'ethers';
import * as crypto from 'crypto';

// ─── Configuration ─────────────────────────────────────────────

const CONFIG = {
  rpcUrl: process.env.TACO_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  daoContract: process.env.DAO_CONTRACT_ADDRESS || '0xYourDAO...',  // CHANGE THIS
  chainId: parseInt(process.env.DAO_CHAIN_ID || '1'),
  ritualId: parseInt(process.env.TACO_RITUAL_ID || '27'),
  privateKey: process.env.WALLET_PRIVATE_KEY!,
};

// ─── Step 1: Initialize TACo SDK ────────────────────────────────

async function main() {
  console.log('[demo] Initializing TACo SDK...');
  await initialize();
  console.log('[demo] TACo ready, using domain:', domains.DEVNET);
  
  // Setup provider and signer
  const provider = new providers.JsonRpcProvider(CONFIG.rpcUrl);
  const wallet = new Wallet(CONFIG.privateKey, provider);
  console.log('[demo] Signer address:', await wallet.getAddress());
  
  // ─── Step 2: Build DAO Token Condition ────────────────────────
  
  console.log('\n[demo] Building DAO token condition...');
  
  // For ERC20: Require balanceOf(userAddress) > 0
  const daoCondition = new conditions.base.contract.ContractCondition({
    method: 'balanceOf',
    parameters: [':userAddress'],  // Context variable resolved at decryption
    standardContractType: 'ERC20',
    contractAddress: CONFIG.daoContract.toLowerCase(),
    chain: CONFIG.chainId,
    returnValueTest: {
      comparator: '>',
      value: '0',  // Must hold at least 1 token
    },
  });
  
  console.log('  Contract:', CONFIG.daoContract);
  console.log('  Chain ID:', CONFIG.chainId);
  console.log('  Condition: balanceOf(:userAddress) > 0');
  
  // ─── Step 3: Encrypt Secret Message ───────────────────────────
  
  const secretMessage = 'This is a SECRET message for DAO holders only!';
  console.log('\n[demo] Encrypting message:', secretMessage.substring(0, 30) + '...');
  
  const messageKit = await encrypt(
    provider,
    domains.DEVNET,
    secretMessage,
    daoCondition,
    CONFIG.ritualId,
    wallet  // For encryptor authentication
  );
  
  console.log('[demo] Encryption successful!');
  
  // ─── Step 4: Serialize messageKit for IPFS Storage ────────────
  
  const serializedMessageKit = JSON.stringify(messageKit, (key, value) => {
    if (value instanceof Uint8Array || value instanceof Buffer) {
      return {
        __type: 'Buffer',
        data: Array.from(value),
      };
    }
    return value;
  });
  
  // Wrap in metadata object
  const ipfsWrapper = {
    schemaVersion: 'taco-v1',
    tacoDomain: 'DEVNET',
    ritualId: CONFIG.ritualId,
    encryptionTimestamp: Math.floor(Date.now() / 1000),
    conditionType: 'ERC20Balance',
    chainId: CONFIG.chainId,
    contractAddress: CONFIG.daoContract,
    minBalance: '1',
    messageKit: JSON.parse(serializedMessageKit),
    metadataHash: computeHash(secretMessage),
  };
  
  console.log('\n[demo] Prepared IPFS wrapper with fields:');
  console.log('  schemaVersion:', ipfsWrapper.schemaVersion);
  console.log('  tacoDomain:', ipfsWrapper.tacoDomain);
  console.log('  ritualId:', ipfsWrapper.ritualId);
  console.log('  conditionType:', ipfsWrapper.conditionType);
  console.log('  messageKit size:', JSON.stringify(ipfsWrapper.messageKit).length, 'bytes');
  
  // ─── Step 5: Upload to IPFS (Pinata Example) ──────────────────
  
  /*
  // Uncomment and configure for actual IPFS upload
  const ipfsResult = await uploadToIpfs(ipfsWrapper, {
    host: 'https://api.pinata.cloud',
    apiKey: process.env.PINATA_API_KEY!,
    secretKey: process.env.PINATA_SECRET_KEY!,
  });
  
  console.log('\n[demo] Uploaded to IPFS:');
  console.log('  CID:', ipfsResult.cid);
  console.log('  URL:', ipfsResult.url);
  
  // Save for decryption demo
  fs.writeFileSync('./encrypted-payload.json', JSON.stringify(ipfsWrapper, null, 2));
  */
  
  // For demo purposes, just log the CID would-be structure
  console.log('\n[demo] To complete:');
  console.log('  1. Configure Pinata/TACo credentials in .env');
  console.log('  2. Uncomment IPFS upload section above');
  console.log('  3. Re-run to get actual CID');
}

// ─── Helper Functions ───────────────────────────────────────────

function computeHash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function uploadToIpfs(wrapper: any, options: {
  host: string;
  apiKey: string;
  secretKey: string;
}): Promise<{ cid: string; url: string }> {
  const FormData = require('form-data');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  
  const tempFile = path.join(os.tmpdir(), `taco-${Date.now()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(wrapper, null, 2), 'utf-8');
  
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempFile));
    
    const response = await fetch(`${options.host}/upload/v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'pinata_secret_api_key': options.secretKey,
      },
      body: formData,
    });
    
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
    }
    
    const result = await response.json();
    return {
      cid: result.IpfsHash,
      url: `https://ipfs.io/ipfs/${result.IpfsHash}`,
    };
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

// ─── Run ────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[demo] Error:', err.message);
  process.exit(1);
});
```

---

## 2. TACo Decryption Snippet (Client-Side)

Fetches messageKit from IPFS, uses EIP4361AuthProvider for SIWE, decrypts.

### Full Example: `taco-decrypt.ts`

```typescript
/**
 * TACo Client-Side Decryption Demo
 * 
 * Fetches encrypted payload from IPFS, authenticates user via SIWE,
 * and decrypts if wallet holds required DAO tokens.
 * 
 * Prerequisites:
 * - User's wallet MUST satisfy the DAO condition (> 0 balance)
 * - Same TACo domain and ritual used during encryption
 */

import { initialize, decrypt, domains } from '@nucypher/taco';
import { conditions } from '@nucypher/taco';
import { EIP4361AuthProvider, USER_ADDRESS_PARAM_DEFAULT } from '@nucypher/taco-auth';
import { providers, Wallet } from 'ethers';
import * as fs from 'fs';

// ─── Configuration ─────────────────────────────────────────────

const CONFIG = {
  rpcUrl: process.env.TACO_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  ipfsGateway: process.env.IPFS_GATEWAY || 'https://ipfs.io',
  privateKey: process.env.DECRYPTOR_PRIVATE_KEY!,  // Wallet to test decryption
};

// ─── Deserialize messageKit from storage ────────────────────────

function deserializeMessageKit(jsonStr: string): any {
  return JSON.parse(jsonStr, (key, value) => {
    if (value && value.__type === 'Buffer') {
      return Buffer.from(value.data);
    }
    return value;
  });
}

// ─── Main Decryption Flow ───────────────────────────────────────

async function main() {
  console.log('[demo] Starting decryption demo...');
  
  // Load encrypted payload (generated by taco-encrypt.ts)
  const wrapperPath = './encrypted-payload.json';
  if (!fs.existsSync(wrapperPath)) {
    console.error('[demo] Error: encrypted-payload.json not found.');
    console.error('[demo] Run taco-encrypt.ts first to generate it.');
    process.exit(1);
  }
  
  const wrapperData = JSON.parse(fs.readFileSync(wrapperPath, 'utf-8'));
  const messageKit = deserializeMessageKit(JSON.stringify(wrapperData.messageKit));
  
  console.log('[demo] Loaded messageKit from:', wrapperPath);
  console.log('  Domain:', wrapperData.tacoDomain);
  console.log('  Ritual:', wrapperData.ritualId);
  console.log('  Condition:', wrapperData.conditionType);
  console.log('  Contract:', wrapperData.contractAddress);
  
  // Initialize TACo
  await initialize();
  console.log('\n[demo] TACo SDK initialized');
  
  // Setup provider and signer
  const provider = new providers.JsonRpcProvider(CONFIG.rpcUrl);
  const wallet = new Wallet(CONFIG.privateKey, provider);
  const userAddress = await wallet.getAddress();
  
  console.log('[demo] Decryptor wallet:', userAddress);
  
  // ─── Create ConditionContext from messageKit ──────────────────
  
  console.log('\n[demo] Setting up ConditionContext...');
  const conditionContext = conditions.context.ConditionContext.fromMessageKit(messageKit);
  
  // Check what context variables are required
  const requiredParams = Array.from(conditionContext.requestedContextParameters.keys());
  console.log('  Required context params:', requiredParams);
  
  if (requiredParams.includes(USER_ADDRESS_PARAM_DEFAULT)) {
    console.log('  → Needs :userAddress authentication (SIWE signature)');
  }
  
  // ─── Add Auth Provider (EIP-4361 / SIWE) ──────────────────────
  
  console.log('\n[demo] Adding EIP4361AuthProvider for SIWE...');
  const authProvider = new EIP4361AuthProvider(provider, wallet);
  conditionContext.addAuthProvider(USER_ADDRESS_PARAM_DEFAULT, authProvider);
  
  console.log('[demo] Auth provider configured - SIWE signature will be prompted');
  
  // ─── Perform Decryption ───────────────────────────────────────
  
  console.log('\n[demo] Requesting decryption fragments from TACo nodes...');
  
  try {
    const decryptedBytes = await decrypt(
      provider,
      domains.DEVNET,
      messageKit,
      conditionContext
    );
    
    // Convert from Uint8Array to string
    const plaintext = new TextDecoder().decode(decryptedBytes);
    
    console.log('\n✅ DECRYPTION SUCCESSFUL!');
    console.log('\nDecrypted plaintext:');
    console.log('─'.repeat(50));
    console.log(plaintext);
    console.log('─'.repeat(50));
    
  } catch (error: any) {
    console.error('\n❌ DECRYPTION FAILED!');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    
    // Classify common errors
    if (error.message.toLowerCase().includes('condition')) {
      console.warn('\n⚠️  Possible causes:');
      console.warn('  • Your wallet does not hold the required DAO tokens');
      console.warn('  • Token balance check failed on-chain');
      console.warn('  • Check balance at Etherscan:', 
        `https://etherscan.io/token/${wrapperData.contractAddress}?a=${userAddress}`);
    } else if (error.message.toLowerCase().includes('authentication')) {
      console.warn('\n⚠️  Authentication failed - try re-signing SIWE message');
    }
    
    process.exit(1);
  }
}

// ─── Run ────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[demo] Fatal error:', err);
  process.exit(1);
});
```

---

## 3. IPFS JSON Schema Template

The exact structure that wraps the TACo messageKit for storage.

```json
{
  "schemaVersion": "taco-v1",
  "tacoDomain": "DEVNET",
  "ritualId": 27,
  "encryptionTimestamp": 1710000000,
  "conditionType": "ERC20Balance",
  "chainId": 1,
  "contractAddress": "0x1234567890123456789012345678901234567890",
  "minBalance": "1",
  "messageKit": {
    "ciphertext": {
      "__type": "Buffer",
      "data": [123, 45, 67, 89, ...]  <-- Serialized bytes
    },
    "encryptedThreshold": [...],
    "transcripts": [...],
    "grant": {...},
    "...": "Other TACo-specific fields"
  },
  "metadataHash": "sha256:a1b2c3d4..."
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | string | Yes | Must be `"taco-v1"` |
| `tacoDomain` | string | Yes | `"DEVNET"` or `"TESTNET"` |
| `ritualId` | number | Yes | DKG cohort ID (e.g., 27) |
| `encryptionTimestamp` | number | Yes | Unix epoch seconds |
| `conditionType` | string | Yes | e.g., `"ERC20Balance"`, `"ERC721Ownership"` |
| `chainId` | number | Yes | Ethereum chain ID (1, 137, etc.) |
| `contractAddress` | string | Yes | DAO token contract (0x...) |
| `minBalance` | string | Yes | Minimum tokens required (as string) |
| `messageKit` | object | Yes | TACo messageKit (serialized) |
| `metadataHash` | string | No | SHA-256 of condition params for integrity |

---

## 4. Condition Builder Helpers

Reusable functions for creating different condition types.

```typescript
/**
 * TacoConditionFactory
 * 
 * Pre-built condition templates for common use cases
 */

import { conditions } from '@nucypher/taco';

export class TacoConditionBuilder {
  
  /**
   * ERC20 Token Holding Condition
   * Requires wallet to hold >= minimumBalance tokens
   */
  static erc20Balance(params: {
    contractAddress: string;
    chainId: number;
    minimumBalance?: string;
  }): conditions.base.contract.ContractCondition {
    return new conditions.base.contract.ContractCondition({
      method: 'balanceOf',
      parameters: [':userAddress'],
      standardContractType: 'ERC20',
      contractAddress: params.contractAddress.toLowerCase(),
      chain: params.chainId,
      returnValueTest: {
        comparator: '>=',
        value: params.minimumBalance ?? '1',
      },
    });
  }
  
  /**
   * ERC721 Collection Ownership (ANY token in collection)
   */
  static erc721Collection(params: {
    contractAddress: string;
    chainId: number;
    minimumTokens?: string;
  }): conditions.base.contract.ContractCondition {
    return new conditions.base.contract.ContractCondition({
      method: 'balanceOf',
      parameters: [':userAddress'],
      standardContractType: 'ERC721',
      contractAddress: params.contractAddress.toLowerCase(),
      chain: params.chainId,
      returnValueTest: {
        comparator: '>=',
        value: params.minimumTokens ?? '1',
      },
    });
  }
  
  /**
   * ERC721 Specific Token ID Ownership
   */
  static erc721TokenId(params: {
    contractAddress: string;
    chainId: number;
    tokenId: string;
  }): conditions.erc721.ERC721Ownership {
    return new conditions.erc721.ERC721Ownership({
      contractAddress: params.contractAddress.toLowerCase(),
      chain: params.chainId,
      parameters: [params.tokenId],
    });
  }
  
  /**
   * Compound Condition (AND / OR logic)
   */
  static compound(params: {
    operator: 'and' | 'or';
    conditions: conditions.base.contract.ContractCondition[];
  }): conditions.compound.CompoundCondition {
    return new conditions.compound.CompoundCondition({
      operator: params.operator,
      operands: params.conditions,
    });
  }
  
  /**
   * Multi-chain DAO Membership
   * Users can hold tokens on ANY of specified chains
   */
  static multiChainDao(tokens: Array<{
    contractAddress: string;
    chainId: number;
    tokenType: 'ERC20' | 'ERC721';
  }>): conditions.compound.CompoundCondition {
    const conditions = tokens.map(token => {
      if (token.tokenType === 'ERC20') {
        return this.erc20Balance({ 
          contractAddress: token.contractAddress, 
          chainId: token.chainId 
        });
      } else {
        // Simplified - handle ERC721 separately
        throw new Error('ERC721 multi-chain not yet implemented');
      }
    });
    
    return this.compound({
      operator: 'or',  // Hold on ANY chain grants access
      conditions,
    });
  }
}

// Usage Examples:
/*
// Single DAO token
const daoCondition = TacoConditionBuilder.erc20Balance({
  contractAddress: '0xGOV_TOKEN...',
  chainId: 1,
  minimumBalance: '10',  // Must hold 10+ tokens
});

// NFT collection membership
const nftCondition = TacoConditionBuilder.erc721Collection({
  contractAddress: '0xBAYC_CONTRACT...',
  chainId: 1,
});

// Specific NFT ownership
const specificNft = TacoConditionBuilder.erc721TokenId({
  contractAddress: '0xPUNK_CONTRACT...',
  chainId: 1,
  tokenId: '1337',
});

// Either DAO tokens OR NFT membership works
const flexCondition = TacoConditionBuilder.compound({
  operator: 'or',
  conditions: [daoCondition, nftCondition],
});

// Multi-chain DAO (hold on Eth OR Polygon)
const multiDao = TacoConditionBuilder.multiChainDao([
  { contractAddress: '0xDAO_ETH...', chainId: 1, tokenType: 'ERC20' },
  { contractAddress: '0xDAO_POLY...', chainId: 137, tokenType: 'ERC20' },
]);
*/
```

---

## 5. Frontend React Hook for Decryption

Simple hook demonstrating how to integrate TACo decryption in a React app.

```typescript
/**
 * useTacoDecrypt
 * 
 * React hook for TACo threshold decryption with SIWE auth
 * Handles caching, loading states, and error classification
 */

import { useState, useCallback, useEffect } from 'react';
import { providers } from 'ethers';
import { initialize, decrypt, domains } from '@nucypher/taco';
import { conditions } from '@nucypher/taco';
import { EIP4361AuthProvider, USER_ADDRESS_PARAM_DEFAULT } from '@nucypher/taco-auth';

interface UseTacoDecryptOptions {
  ipfsGateway?: string;
  autoInitialize?: boolean;
}

interface TacoDecryptState {
  loading: boolean;
  error: string | null;
  lastDecryptedAt: number | null;
  authCached: boolean;
}

export function useTacoDecrypt(options: UseTacoDecryptOptions = {}) {
  const [state, setState] = useState<TacoDecryptState>({
    loading: false,
    error: null,
    lastDecryptedAt: null,
    authCached: false,
  });
  
  const [initialized, setInitialized] = useState(false);
  
  // Initialize TACo SDK on mount
  useEffect(() => {
    if (options.autoInitialize !== false) {
      initialize().then(() => {
        setInitialized(true);
        console.log('[taco-hook] TACo SDK initialized');
      }).catch(err => {
        console.error('[taco-hook] Initialization failed:', err);
        setState(s => ({ ...s, error: 'TACo initialization failed' }));
      });
    }
  }, []);
  
  const decryptContent = useCallback(async (
    messageKitJson: string,
    signer: providers.Signer,
    provider: providers.Provider
  ): Promise<string> => {
    if (!initialized) {
      throw new Error('TACo SDK not initialized');
    }
    
    setState(s => ({ ...s, loading: true, error: null }));
    
    try {
      // Deserialize messageKit
      const messageKit = JSON.parse(messageKitJson, (key, value) => {
        if (value?.__type === 'Buffer') {
          return Buffer.from(value.data);
        }
        return value;
      });
      
      // Create ConditionContext
      const conditionContext = conditions.context.ConditionContext.fromMessageKit(messageKit);
      
      // Check cache status
      const hasUserAddress = conditionContext.requestedContextParameters.has(
        USER_ADDRESS_PARAM_DEFAULT
      );
      
      // Add auth provider
      const authProvider = new EIP4361AuthProvider(provider, signer);
      conditionContext.addAuthProvider(USER_ADDRESS_PARAM_DEFAULT, authProvider);
      
      // Get user address for logging
      const userAddress = await signer.getAddress();
      
      console.log('[taco-hook] Starting decryption for:', userAddress);
      const startTime = Date.now();
      
      // Perform decryption
      const decryptedBytes = await decrypt(
        provider,
        domains.DEVNET,
        messageKit,
        conditionContext
      );
      
      const elapsed = Date.now() - startTime;
      console.log(`[taco-hook] Decryption completed in ${elapsed}ms`);
      
      // Decode to string
      const plaintext = new TextDecoder().decode(decryptedBytes);
      
      // Update state
      setState(s => ({
        ...s,
        loading: false,
        lastDecryptedAt: Date.now(),
        authCached: true,  // Assume cached after success
      }));
      
      return plaintext;
      
    } catch (error: any) {
      console.error('[taco-hook] Decryption failed:', error);
      
      const errorMessage = error.message || 'Unknown error';
      let userFriendlyError = 'Decryption failed';
      
      if (errorMessage.toLowerCase().includes('condition')) {
        userFriendlyError = 'You do not have permission to decrypt this content';
      } else if (errorMessage.toLowerCase().includes('signature')) {
        userFriendlyError = 'Authentication failed. Please sign the message again.';
      } else if (errorMessage.toLowerCase().includes('network')) {
        userFriendlyError = 'Network error. Please check your connection.';
      }
      
      setState(s => ({
        ...s,
        loading: false,
        error: userFriendlyError,
      }));
      
      throw error;
    }
  }, [initialized]);
  
  const clearCache = useCallback(() => {
    setState(s => ({ ...s, authCached: false, lastDecryptedAt: null }));
  }, []);
  
  return {
    decryptContent,
    clearCache,
    ...state,
    initialized,
  };
}
```

---

## 6. Quick Start Test Script

Run this to verify your setup before integrating into production code.

```bash
#!/bin/bash
# setup-taco-dev.sh

echo "🔧 Setting up TACo development environment..."

# Environment variables (.env)
cat > .env << EOF
# TACo Configuration
TACO_RPC_URL=https://ethereum-rpc.publicnode.com
TACO_DOMAIN=DEVNET
TACO_RITUAL_ID=27

# DAO Token (CHANGE THESE!)
DAO_CONTRACT_ADDRESS=0xYourDAOContractAddressHere
DAO_CHAIN_ID=1

# Wallet (for testing - use TESTNET funds ONLY!)
WALLET_PRIVATE_KEY=0xYourTestWalletPrivateKey

# IPFS (optional - for upload tests)
IPFS_GATEWAY=https://ipfs.io
PINATA_API_KEY=
PINATA_SECRET_KEY=
EOF

echo ""
echo "✅ Environment file created: .env"
echo ""
echo "📝 NEXT STEPS:"
echo "  1. Edit .env with your DAO contract address"
echo "  2. Ensure you have test ETH for RPC fees"
echo "  3. Run: npm run taco-encrypt"
echo "  4. Then: npm run taco-decrypt"
echo ""
echo "⚠️  WARNING: DEVNET is testnet only - DO NOT use production data!"
```

---

