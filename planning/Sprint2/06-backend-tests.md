# S2-T6: Backend Unit Tests for Middleware Logic

**Owner:** QA Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S2-T1 through S2-T5 complete  
**Acceptance Criteria:**
- [ ] Unit tests cover middleware initialization flow
- [ ] Unit tests verify metadata schema generation
- [ ] Mock-based tests for encryption/decryption paths (no network)
- [ ] Test coverage > 80% for `src/middleware/encrypt.ts`
- [ ] Integration test stub prepared for manual TACo testing

---

## Test Suite Structure

```
tests/taco/
├── unit/
│   ├── key-wrapper.test.ts          # TacoKeyWrapper logic
│   ├── conditions.test.ts            # DaoCondition builders
│   ├── serialization.test.ts         # messageKit serialize/deserialize
│   └── middleware.test.ts            # Encrypt middleware contract
├── e2e/
│   ├── e2e.test.ts                   # Full TACo integration (network)
│   └── run-e2e-tests.js              # Test runner script
└── fixtures/
    ├── mock-dao-condition.json
    └── mock-messagekit.json
```

---

## Sample Test: Middleware Contract Verification

```typescript
// tests/taco/unit/middleware.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEncryptMiddleware } from '../../../src/middleware/encrypt';
import * as fs from 'fs';

describe('TacoEncryptMiddleware', () => {
  let handle: ReturnType<typeof createEncryptMiddleware>;
  
  const mockOptions = {
    litEncryptKey: async (_key: Buffer, _accs: any[], _chain: string) => ({
      ciphertext: JSON.stringify({ mock: 'messagekit' }),
      dataToEncryptHash: 'abc123def456',
    }),
    walletAddress: '0xTestWallet',
    chain: 'ethereum',
    daoContractAddress: '0xDAO_TOKEN_ADDRESS',
    daoChainId: 1,
    daoTokenType: 'ERC20' as const,
    tacoRitualId: 27,
  };
  
  beforeEach(() => {
    handle = createEncryptMiddleware(mockOptions);
  });
  
  afterEach(() => {
    handle.destroy();
    // Clean up mocks
  });
  
  describe('Lifecycle', () => {
    it('should reject onResponse() without initialize()', async () => {
      const mockPayload = {
        context: { requestId: 'test-1' },
        openaiResponse: { choices: [{ message: { content: 'test' } }] },
      } as any;
      
      await expect(
        handle.middleware.onResponse!(mockPayload, async () => {})
      ).rejects.toThrow('not initialised');
    });
    
    it.skip('should initialize successfully with valid config', async () => {
      // Requires actual TACo setup - manual test only
      await handle.initialize();
      // Verify state
    });
  });
  
  describe('Metadata', () => {
    it('should generate valid taco-v1 metadata after init', async () => {
      // Skip unless TACo mocked properly
      // assert(metadata.version === 'taco-v1')
      // assert(metadata.tacoDomain === 'DEVNET')
      // assert(metadata.ritualId === 27)
    });
    
    it('should include dao contract info in accessControlConditions', () => {
      // Validate condition structure matches spec
    });
  });
  
  describe('Session Recovery', () => {
    const tempMetadataPath = '/tmp/test-taco-metadata.json';
    
    afterEach(() => {
      try { fs.unlinkSync(tempMetadataPath); } catch {}
    });
    
    it('should reject invalid schema version on recovery', async () => {
      // Write fake legacy metadata
      fs.writeFileSync(tempMetadataPath, JSON.stringify({
        version: 'hybrid-v1',
        /* ... */
      }));
      
      const recoveringHandle = createEncryptMiddleware({
        ...mockOptions,
        keyMetadataPath: tempMetadataPath,
        litDecryptKey: async () => Buffer.alloc(32),
      });
      
      await expect(recoveringHandle.initialize())
        .rejects.toThrow('Unsupported metadata version');
    });
  });
});
```

---

## Coverage Report Requirements

Run:
```bash
npx vitest run --coverage
```

Target metrics:
| File | Target Coverage | Current (baseline) |
|------|-----------------|--------------------|
| `src/middleware/encrypt.ts` | >80% | N/A |
| `src/utils/taco-key-wrapper.ts` | >75% | N/A |
| `src/utils/taco-conditions.ts` | >85% | N/A |

---

## Manual Integration Checklist

For QA engineer to execute before marking S2-T6 complete:

- [ ] Set up test wallets configured in `.env`:
  - One wallet WITH tokens at DAO contract
  - One wallet WITHOUT tokens
- [ ] Run encrypted request through local shim instance
- [ ] Verify first request shows SIWE signature prompt
- [ ] Verify second request uses cached auth (no re-prompt)
- [ ] Capture logs showing `CONDITION_NOT_MET` for non-holder attempts
- [ ] Confirm IPFS upload includes new `taco-v1` metadata
- [ ] Check monitoring/logs for decryption latency distribution

---

## Dependencies

- Depends on ALL Sprint 2 tasks
- Validates full backend layer before frontend integration (Sprint 3)

---

## Success Metrics

- ✅ Automated test suite runs without network dependencies
- ✅ Code coverage thresholds met
- ✅ Manual E2E verification completed successfully
- ✅ No regressions in existing non-Lit functionality

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 5 of Sprint 2

---

# Sprint 2 Complete Criteria

[ ] All S2-T1 through S2-T6 marked complete  
[ ] Backend build passes with no Lit references  
[ ] Test suite green (unit + manual integration verified)  
[ ] Product review completed; no blockers identified  
[ ] Sprint 3 kickoff scheduled  

---

# Code Review Checklist for S2 PR

Before merging Sprint 2 work:

- [ ] No `@lit-protocol` imports remain in codebase
- [ ] Package.json shows only TACo dependencies
- [ ] README updated with new CLI usage examples
- [ ] Migration guide (`TACO-MIGRATION-NOTES.md`) written
- [ ] Breaking change clearly documented in commit message
- [ ] Environment variable documentation complete
- [ ] All TODO comments addressed or ticketed separately

---

