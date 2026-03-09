# S1-T3: Create DAO Token-Holder Condition Builder (ERC20/ERC721 Balance Check)

**Owner:** Backend Engineer  
**Estimated Effort:** 1.5 days  
**Dependencies:** S1-T1, S1-T2  
**Acceptance Criteria:**
- [ ] ERC20 balance condition generated: `balanceOf(userAddress) > 0`
- [ ] ERC721 ownership condition generated: `ownerOf(tokenId) == userAddress` OR `balanceOf(userAddress) > 0`
- [ ] Conditions use `:userAddress` context variable (verified at decryption time via SIWE)
- [ ] Chain parameter configurable per token contract
- [ ] Unit tests verify JSON structure matches TACo SDK expectations

---

## Technical Specification

### Condition Structure Overview

TACo uses `ContractCondition` or predefined conditions like `ERC20Balance` and `ERC721Ownership`. For DAO gating, we need **balance checks**:

#### ERC20 Token (Fungible DAO Tokens)
- Goal: User must hold at least 1 token
- Contract method: `balanceOf(address)` returns `uint256`
- Test: return value > 0

```typescript
import { conditions } from '@nucypher/taco';

const daoTokenCondition = new conditions.base.contract.ContractCondition({
  method: 'balanceOf',
  parameters: [':userAddress'],  // Context variable resolved at decryption
  standardContractType: 'ERC20',
  contractAddress: '0xYourDAOContract...',
  chain: 1,  // Ethereum Mainnet
  returnValueTest: {
    comparator: '>',
    value: '0',  // Must be string in contract condition
  },
});
```

#### ERC721 Token (NFT-based DAO Membership)
- Option A: Own any NFT from collection (balance check)
- Option B: Own specific token ID (ownership check)

```typescript
// Option A: Own at least one NFT
const nftCollectionCondition = new conditions.base.contract.ContractCondition({
  method: 'balanceOf',
  parameters: [':userAddress'],
  standardContractType: 'ERC721',
  contractAddress: '0xYourNFTCollection...',
  chain: 1,
  returnValueTest: {
    comparator: '>',
    value: '0',
  },
});

// Option B: Own specific token ID (useful if multiple collections allowed)
const specificNftCondition = new conditions.erc721.ERC721Ownership({
  contractAddress: '0xYourNFTCollection...',
  chain: 1,
  parameters: ['5954'],  // Token ID
});
```

### Predefined vs. Custom Conditions

TACo provides helper classes in `conditions.predefined`:

| Predefined Class | Use Case | Example |
|------------------|----------|---------|
| `ERC20Balance` | Fungible token balance threshold | "Must hold 100+ GOV tokens" |
| `ERC721Ownership` | Own specific NFT token ID | "Must own BoredApe #1234" |
| `ERC721Balance` | Own any NFT from collection | "Must own at least 1 PUNK" |

For our use case (DAO membership), we'll start with:
- **ERC20**: `balanceOf(:userAddress) > 0` with configurable contract
- **ERC721**: `balanceOf(:userAddress) > 0` for collection-wide access

---

## Implementation Details

### File: `src/utils/taco-conditions.ts`

```typescript
/**
 * DAO Token Condition Builders
 * 
 * Generates TACo conditions that gate decryption access to DAO token holders
 */

import { conditions } from '@nucypher/taco';

export interface DaoTokenConditionParams {
  /** EVM chain ID where the token contract lives */
  chain: number;
  
  /** Token contract address (must be ERC20 or ERC721) */
  contractAddress: string;
  
  /** Token type */
  tokenType: 'ERC20' | 'ERC721';
  
  /** For ERC721: specific token ID to require ownership of (optional) */
  tokenId?: string;
  
  /** Minimum balance required (default: '1' for any holder) */
  minimumBalance?: string;
}

/**
 * Build a DAO token-holding condition
 * 
 * - ERC20: balanceOf(userAddress) >= minimumBalance
 * - ERC721 (with tokenId): ownerOf(tokenId) == userAddress
 * - ERC721 (without tokenId): balanceOf(userAddress) >= minimumBalance
 */
export function buildDaoCondition(params: DaoTokenConditionParams): conditions.base.contract.ContractCondition {
  const { chain, contractAddress, tokenType } = params;
  const minBalance = params.minimumBalance ?? '1';
  
  // Normalize contract address
  const normalizedAddress = contractAddress.startsWith('0x') 
    ? contractAddress.toLowerCase()
    : `0x${contractAddress}`;
  
  if (tokenType === 'ERC20') {
    return new conditions.base.contract.ContractCondition({
      method: 'balanceOf',
      parameters: [':userAddress'],
      standardContractType: 'ERC20',
      contractAddress: normalizedAddress,
      chain: chain,
      returnValueTest: {
        comparator: '>=',
        value: minBalance,
      },
    });
  }
  
  if (tokenType === 'ERC721') {
    if (params.tokenId) {
      // Specific token ID ownership
      return new conditions.erc721.ERC721Ownership({
        contractAddress: normalizedAddress,
        chain: chain,
        parameters: [params.tokenId],
      });
    } else {
      // Any NFT from collection
      return new conditions.base.contract.ContractCondition({
        method: 'balanceOf',
        parameters: [':userAddress'],
        standardContractType: 'ERC721',
        contractAddress: normalizedAddress,
        chain: chain,
        returnValueTest: {
          comparator: '>=',
          value: minBalance,
        },
      });
    }
  }
  
  throw new Error(`[taco] Unsupported token type: ${tokenType}`);
}

/**
 * Build a compound condition combining multiple token requirements
 * 
 * Example: Holder of EITHER ERC20 OR ERC721 can decrypt
 */
export function buildCompoundDaoCondition(
  conditions: conditions.base.contract.ContractCondition[],
  operator: 'and' | 'or' = 'or'
): conditions.compound.CompoundCondition {
  return new conditions.compound.CompoundCondition({
    operator: operator,
    operands: conditions,
  });
}

/**
 * Validate condition parameters before use
 */
export function validateDaoConditionParams(params: DaoTokenConditionParams): void {
  const errors: string[] = [];
  
  // Chain ID validation
  if (!Number.isInteger(params.chain) || params.chain <= 0) {
    errors.push(`Invalid chain ID: ${params.chain}. Must be positive integer.`);
  }
  
  // Contract address validation (loose check)
  if (!/^0x[a-fA-F0-9]{40}$/.test(params.contractAddress)) {
    errors.push(`Invalid contract address: ${params.contractAddress}`);
  }
  
  // Token type validation
  if (!['ERC20', 'ERC721'].includes(params.tokenType)) {
    errors.push(`Invalid token type: ${params.tokenType}`);
  }
  
  // Token ID validation (if provided)
  if (params.tokenId && !/^\d+$/.test(params.tokenId)) {
    errors.push(`Invalid token ID: ${params.tokenId}. Must be numeric.`);
  }
  
  // Minimum balance validation
  if (params.minimumBalance && !/^\d+$/.test(params.minimumBalance)) {
    errors.push(`Invalid minimum balance: ${params.minimumBalance}. Must be non-negative integer as string.`);
  }
  
  if (errors.length > 0) {
    throw new Error(`[taco] Invalid DAO condition params:\n${errors.join('\n')}`);
  }
}
```

---

## Usage Examples

### Example 1: Simple ERC20 DAO Token
```typescript
const daoCondition = buildDaoCondition({
  chain: 1,  // Ethereum mainnet
  contractAddress: '0x1234...5678',
  tokenType: 'ERC20',
  minimumBalance: '1',
});
```

### Example 2: ERC721 Collection Access
```typescript
const nftCondition = buildDaoCondition({
  chain: 137,  // Polygon
  contractAddress: '0xabcd...efgh',
  tokenType: 'ERC721',
  minimumBalance: '1',
});
```

### Example 3: Compound (Multi-Token) Access
```typescript
const condition1 = buildDaoCondition({
  chain: 1,
  contractAddress: '0xDAO_TOKEN...',
  tokenType: 'ERC20',
});

const condition2 = buildDaoCondition({
  chain: 137,
  contractAddress: '0xNFT_COLLECTION...',
  tokenType: 'ERC721',
});

// Either token grants access
const compound = buildCompoundDaoCondition([condition1, condition2], 'or');
```

---

## Testing Plan

### Unit Tests
```typescript
// tests/taco/conditions.test.ts
import { describe, it, expect } from 'vitest';
import { buildDaoCondition, validateDaoConditionParams } from '../../src/utils/taco-conditions';

describe('DaoCondition Builder', () => {
  it('should build valid ERC20 condition', () => {
    const condition = buildDaoCondition({
      chain: 1,
      contractAddress: '0x1234567890123456789012345678901234567890',
      tokenType: 'ERC20',
      minimumBalance: '1',
    });
    
    expect(condition).toBeDefined();
    expect((condition as any).method).toBe('balanceOf');
    expect((condition as any).standardContractType).toBe('ERC20');
    expect(((condition as any).returnValueTest.comparator)).toBe('>=');
    expect(((condition as any).parameters[0])).toBe(':userAddress');
  });

  it('should reject invalid chain ID', () => {
    expect(() => buildDaoCondition({
      chain: -1,
      contractAddress: '0x1234567890123456789012345678901234567890',
      tokenType: 'ERC20',
    })).toThrow('Invalid chain ID');
  });

  it('should reject invalid contract address', () => {
    expect(() => buildDaoCondition({
      chain: 1,
      contractAddress: 'not-an-address',
      tokenType: 'ERC20',
    })).toThrow('Invalid contract address');
  });

  it('should build ERC721 with specific token ID', () => {
    const condition = buildDaoCondition({
      chain: 1,
      contractAddress: '0x1234567890123456789012345678901234567890',
      tokenType: 'ERC721',
      tokenId: '1337',
    });
    
    expect(condition).toBeDefined();
  });
});
```

### Integration Test: Serialisation
```javascript
// tests/taco/conditions-integration.test.js
const { buildDaoCondition } = require('../../dist/utils/taco-conditions');

const condition = buildDaoCondition({
  chain: 1,
  contractAddress: '0x1234567890123456789012345678901234567890',
  tokenType: 'ERC20',
  minimumBalance: '1',
});

// Convert to JSON (what gets sent to TACo nodes)
const json = JSON.parse(JSON.stringify(condition));

console.log('Condition JSON structure:');
console.log(JSON.stringify(json, null, 2));

// Verify expected keys
const keys = Object.keys(json);
console.assert(keys.includes('method'), 'Missing "method" key');
console.assert(keys.includes('chain'), 'Missing "chain" key');
console.assert(keys.includes('parameters'), 'Missing "parameters" key');
```

---

## Environment Configuration

Add to `.env.example`:
```bash
# TACo DAO Condition Configuration
DAO_TOKEN_CHAIN=1
DAO_TOKEN_CONTRACT_ADDRESS=0x...
DAO_TOKEN_TYPE=ERC20
DAO_TOKEN_MINIMUM_BALANCE=1
```

---

## Edge Cases & Considerations

### Multi-chain Tokens
If DAO token exists on multiple chains:
- Prompt user to select which chain their tokens are on
- OR create compound condition spanning chains (adds network latency for evaluation)

### Zero-Balance Edge Case
Setting `minimumBalance: '0'` would allow ANYONE to decrypt (bypasses gating). Warn users during configuration.

### Token Revoke / Transfer Scenarios
If user transfers tokens after encryption:
- They may still decrypt using cached signatures (see S3-T5 for caching)
- Real-time balance check at decryption mitigates this risk

---

## Success Metrics
- ✅ Conditions serialize correctly to JSON
- ✅ All unit tests pass
- ✅ Condition structure validates against TACo SDK schema
- ✅ Integration test produces readable, debuggable output

---

## Dependencies
- Blocks S1-T4 (encryption needs condition)
- Depends on S1-T2 (condition requires working taco client)

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 4-5 of Sprint 1
