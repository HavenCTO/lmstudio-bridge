# S2-T5: Update Encryption Metadata Schema for TACo

**Owner:** Backend Engineer  
**Estimated Effort:** 0.5 days  
**Dependencies:** S2-T3, S2-T4  
**Acceptance Criteria:**
- [ ] `EncryptionMetadata` interface includes new TACo fields
- [ ] Old `hybrid-v1` schema marked deprecated in docs
- [ ] Backwards incompatible (no migration path for old data — documented)
- [ ] IPFS upload logic handles new schema version
- [ ] Decryption spec updated to reflect TACo metadata format

---

## Technical Specification

### Before Lit v8 Schema

```typescript
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
```

### After TACo Schema

```typescript
export interface EncryptionMetadata {
  version: "taco-v1";    // CHANGED from "hybrid-v1"
  encryptedKey: string;
  keyHash: string;
  algorithm: "AES-GCM";
  keyLength: number;
  ivLengthBytes: number;
  accessControlConditions: TacoAccessControlCondition[]; // New structure
  chain: string;
  tacoDomain: string;         // NEW: "DEVNET" or "TESTNET"
  ritualId: number;           // NEW: e.g., 27
  metadataCid?: string;
}
```

### Key Differences & Rationale

| Field | Change | Reason |
|-------|--------|--------|
| `version` | `"hybrid-v1"` → `"taco-v1"` | Major schema break; prevents accidental use of incompatible decryptors |
| `accessControlConditions` | Structure changed | Lit used ACC array; TACo uses `ContractCondition` JSON structure |
| `tacoDomain` | ADDED | Required by TACo SDK to select network domain |
| `ritualId` | ADDED | TACo identifies encryption cohort by ritual ID |

---

## File Changes

### 1. `src/middleware/encrypt.ts` (Types Section)

Already shown in S2-T3 implementation, but confirm types match spec above.

### 2. `docs/decryption-spec.md` (Update Section 2)

Replace existing schema with:

```markdown
#### Encryption Metadata Schema (TACo v1)

Fetch the `metadataCid` from IPFS. The content is a JSON file conforming to:

```json
{
  "version": "taco-v1",
  "encryptedKey": "<base64-encoded serialized messageKit>",
  "keyHash": "<hex SHA-256 of the raw 32-byte AES key>",
  "algorithm": "AES-GCM",
  "keyLength": 256,
  "ivLengthBytes": 12,
  "accessControlConditions": [
    {
      "contractAddress": "0xDAO_TOKEN...",
      "standardContractType": "ERC20",
      "chain": 1,
      "method": "balanceOf",
      "parameters": [":userAddress"],
      "returnValueTest": {
        "comparator": ">",
        "value": "0"
      }
    }
  ],
  "chain": "ethereum",
  "tacoDomain": "DEVNET",
  "ritualId": 27
}
```

**Deprecated:** The previous `hybrid-v1` schema using Lit Protocol is no longer supported. Payloads encrypted under that schema CANNOT be decrypted after this migration.

**Field Reference:** Same as before, except:
- `encryptedKey` now contains base64-encoded **serialized messageKit** (not Lit BLS-IBE ciphertext)
- `tacoDomain`: Must match the TACo domain used during encryption (`DEVNET`, `TESTNET`)
- `ritualId`: Identifies the DKG cohort (e.g., 27 for DEVNET Open Ritual)
```

### 3. `docs/TACO-MIGRATION-NOTES.md` (Create)

New document:

```markdown
# TACo Migration Notes

## Overview

This project migrated from Lit Protocol v8 to TACo (Threshold Access Control) in March 2026.

## Breaking Changes

### Data Compatibility

❌ **NO MIGRATION PATH for existing data.**

All payloads encrypted under Lit v8's `hybrid-v1` schema become UNREADABLE after migration. This was an accepted risk communicated to Product/Legal teams.

If you have existing Lit-encrypted data on IPFS:
- It cannot be decrypted using TACo SDK
- Re-encryption would require decryption first (which requires Lit credentials and working Lit network)
- Recommendation: Archive old data with clear deprecation notice

### Metadata Version Check

Any code reading encryption metadata should check `version` field:

```typescript
if (metadata.version === 'hybrid-v1') {
  throw new Error('Legacy Lit-encrypted data not supported. Please re-encrypt.');
}

if (metadata.version !== 'taco-v1') {
  throw new Error(`Unknown metadata version: ${metadata.version}`);
}
```

## Configuration Migration

### Old (Lit) Environment Variables

```bash
LIT_NETWORK=datil-dev
LIT_CHAIN=ethereum
WALLET_ADDRESS=0x...
HAVEN_PRIVATE_KEY=0x... # Still works
```

### New (TACo) Environment Variables

```bash
TACO_DOMAIN=DEVNET                      # or TESTNET
TACO_RITUAL_ID=27                       # Default for DEVNET
DA_TOKEN_CONTRACT_ADDRESS=0x...         # REQUIRED
DAO_TOKEN_CHAIN_ID=1                    # E.g., Ethereum mainnet
DAO_TOKEN_TYPE=ERC20                    # or ERC721
WALLET_PRIVATE_KEY=0x...                 # Encryptor identity
```

## Troubleshooting

### Common Issues

1. **"Invalid ritual ID" error**
   - Ensure `ritualId` matches your TACo domain (27 for DEVNET, 6 for TESTNET)
   - Verify ritual status at https://lynx-3.nucypher.network:9151/status

2. **"Condition not met" when user holds tokens**
   - Check `chain` ID matches token deployment network
   - Verify contract address in condition matches actual DAO token
   - Confirm user's wallet has tokens (> 0 balance)

3. **"Network timeout" during decryption**
   - TACo nodes may experience latency; implement retry/backoff
   - Consider exposing `TACO_NODE_TIMEOUT` env var (default: 30s)

## Rollback Procedure

Reverting to Lit v8 is NOT RECOMMENDED but possible:
1. Deploy previous build artifact from Git tag
2. Restore package.json to prior dependencies (Lit v8 packages)
3. Old encrypted data STILL won't work (schema mismatch within Lit too)

See `/planning/ORCHESTRATOR.md` for full rollback matrix.
```

---

## Testing Plan

### Unit Test: Schema Validation

```typescript
// tests/taco/schema.test.ts
import { describe, it, expect } from 'vitest';

describe('Encryption Metadata Schema', () => {
  it('should reject hybrid-v1 (legacy) schema', () => {
    const legacy = {
      version: 'hybrid-v1',
      /* ... */
    };
    
    expect(legacy.version).toBe('hybrid-v1');
    // Later code will throw on this
  });
  
  it('should accept taco-v1 schema', () => {
    const valid = {
      version: 'taco-v1',
      encryptedKey: 'mock',
      keyHash: 'abc123...',
      algorithm: 'AES-GCM',
      keyLength: 256,
      ivLengthBytes: 12,
      accessControlConditions: [{/* ... */}],
      chain: 'ethereum',
      tacoDomain: 'DEVNET',
      ritualId: 27,
    };
    
    expect(valid.version).toBe('taco-v1');
    expect(valid.tacoDomain).toMatch(/^(DEVNET|TESTNET)$/);
    expect(Number.isInteger(valid.ritualId)).toBe(true);
  });
});
```

---

## Success Metrics

- ✅ All metadata objects include `tacoDomain` and `ritualId`
- ✅ Schema version enforced (rejects old versions)
- ✅ Documentation clearly warns about incompatibility
- ✅ Error messages guide users away from legacy data

---

## Dependencies

- Depends on S2-T3 (middleware uses new schema)
- Unblocks production deployment (clear schema version required)

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 4-5 of Sprint 2
