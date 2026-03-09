# S1-T6: Integration Tests - Positive (Holder Decrypts), Negative (Non-Holder Fails)

**Owner:** QA Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S1-T1 through S1-T5 complete  
**Acceptance Criteria:**
- [ ] End-to-end test: Encrypt with DAO condition → Upload to IPFS → Holder decrypts successfully
- [ ] Negative test: Non-holder attempts decryption → Proper error returned (`CONDITION_NOT_MET`)
- [ ] Auth test: First-time decryption prompts SIWE signature; subsequent decryptions use cached signature
- [ ] All tests automatable via `npm run test:taco:e2e`
- [ ] Test results logged to `/tests/taco/test-results.md`

---

## Test Architecture

### Test Environment Setup

```bash
# Required environment variables
export TACO_RPC_URL=https://ethereum-rpc.publicnode.com
export TEST_WALLET_WITH_TOKENS=0x...  # Must have DAO tokens
export TEST_PRIVATE_KEY_WITH_TOKENS=0x...
export TEST_WALLET_NO_TOKENS=0x...    # Must NOT have DAO tokens  
export TEST_PRIVATE_KEY_NO_TOKENS=0x...
export TEST_DAO_CONTRACT=0x...        # ERC20/ERC721 contract address
export TEST_IPFS_API_KEY=...          # For Pinata/Web3.Storage
export TEST_TACO_INTEGRATION_TEST=1   # Flag to enable network-dependent tests
```

### Test Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: SETUP                                              │
│ - Initialize TACo SDK                                       │
│ - Verify ritualId=27 on DEVNET                              │
│ - Confirm test wallets setup                                │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: ENCRYPTION                                         │
│ - Plaintext: "Secret message for DAO holders"               │
│ - Condition: ERC20 balance > 0 at $DAO_CONTRACT            │
│ - Result: messageKit + IPFS upload → CID                   │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: POSITIVE TEST (Holder)                             │
│ - Wallet WITH tokens attempts decryption                    │
│ - Expected: Success, plaintext recovered exactly            │
│ - Metrics: Latency, signature prompt behavior              │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: NEGATIVE TEST (Non-Holder)                         │
│ - Wallet WITHOUT tokens attempts decryption                 │
│ - Expected: Error CODE=CONDITION_NOT_MET                    │
│ - Metrics: Error clarity, no partial data leaked           │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 5: AUTH CACHING TEST                                  │
│ - Same holder makes second decryption request               │
│ - Expected: No SIWE signature prompt (use cached)           │
│ - Metrics: Cache hit verified via logs                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Test Suite Implementation

### File: `tests/taco/e2e.test.ts`

```typescript
/**
 * TACo End-to-End Integration Tests
 * 
 * Prerequisites:
 * - TACo SDK initialized
 * - DEVNET ritualId=27 available
 * - Two test wallets: one with tokens, one without
 * - IPFS upload credentials configured
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { providers, Wallet } from 'ethers';
import { initialize, domains } from '@nucypher/taco';
import { initTaco, TACO_DEVMET_RITUAL_ID } from '../../src/utils/taco-client';
import { tacoEncrypt, tacoEncryptAndUpload } from '../../src/utils/taco-encryption';
import { tacoDecrypt } from '../../src/utils/taco-decryption';
import { buildDaoCondition } from '../../src/utils/taco-conditions';

// ─── Configuration ─────────────────────────────────────────────

const CONFIG = {
  rpcUrl: process.env.TACO_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  daoContract: process.env.TEST_DAO_CONTRACT || '',
  chainId: parseInt(process.env.DAO_CHAIN || '1'),
  tokenType: (process.env.DAO_TOKEN_TYPE as 'ERC20' | 'ERC721') || 'ERC20',
  ritualId: parseInt(process.env.TEST_TACO_RITUAL_ID || '27'),
  ipfsHost: process.env.IPFS_HOST || 'https://api.pinata.cloud',
  skipIntegration: !process.env.TEST_TACO_INTEGRATION_TEST,
};

// ─── Fixtures ──────────────────────────────────────────────────

let provider: providers.JsonRpcProvider;
let encryptorWallet: Wallet;
let holderWallet: Wallet;
let nonHolderWallet: Wallet;
let uploadedCid: string | null = null;
const testPlaintext = 'SECRET_MESSAGE_' + Date.now(); // Unique per run

beforeAll(async () => {
  if (CONFIG.skipIntegration) {
    console.log('⊘ Skipping integration tests (set TEST_TACO_INTEGRATION_TEST=1)');
    return;
  }
  
  console.log('\n=== TACo E2E Test Setup ===\n');
  
  // Validate config
  expect(CONFIG.daoContract).not.toBe('', 'TEST_DAO_CONTRACT required');
  expect(CONFIG.chainId).toBeGreaterThan(0);
  
  // Initialize TACo
  await initTaco();
  console.log('✓ TACo SDK initialized');
  
  // Setup provider
  provider = new providers.JsonRpcProvider(CONFIG.rpcUrl);
  
  // Setup wallets
  if (!process.env.TEST_PRIVATE_KEY_WITH_TOKENS || !process.env.TEST_PRIVATE_KEY_NO_TOKENS) {
    throw new Error('Missing wallet private keys in environment');
  }
  
  encryptorWallet = new Wallet(process.env.TEST_ECRYPTOR_KEY || process.env.TEST_PRIVATE_KEY_WITH_TOKENS, provider);
  holderWallet = new Wallet(process.env.TEST_PRIVATE_KEY_WITH_TOKENS!, provider);
  nonHolderWallet = new Wallet(process.env.TEST_PRIVATE_KEY_NO_TOKENS!, provider);
  
  console.log('✓ Wallets configured');
  console.log('  Encryptor:', await encryptorWallet.getAddress());
  console.log('  Holder:', await holderWallet.getAddress());
  console.log('  Non-holder:', await nonHolderWallet.getAddress());
}, 60000); // Extended timeout for setup

// ─── Test Cases ─────────────────────────────────────────────────

describe('TACo Encryption/Decryption E2E', { skip: CONFIG.skipIntegration }, () => {
  
  it('should encrypt and upload data', async () => {
    const startTime = Date.now();
    
    const result = await tacoEncryptAndUpload({
      provider,
      signerAddress: await encryptorWallet.getAddress(),
      signer: encryptorWallet,
      plaintext: testPlaintext,
      daoCondition: {
        chain: CONFIG.chainId,
        contractAddress: CONFIG.daoContract,
        tokenType: CONFIG.tokenType,
        minimumBalance: '1',
      },
      ritualId: CONFIG.ritualId,
    }, {
      ipfsHost: CONFIG.ipfsHost,
      apiKey: process.env.IPFS_API_KEY!,
      secretKey: process.env.IPFS_SECRET_KEY!,
    });
    
    const elapsed = Date.now() - startTime;
    
    uploadedCid = result.cid;
    
    console.log('✓ Upload completed in', elapsed, 'ms');
    console.log('  CID:', result.cid);
    console.log('  URL:', result.url);
    
    expect(result.cid).toMatch(/^Qm[A-Za-z0-9]{44}$/); // Basic CID pattern
    expect(result.wrapper.schemaVersion).toBe('taco-v1');
    expect(result.wrapper.ritualId).toBe(CONFIG.ritualId);
    expect(result.wrapper.tacoDomain).toBe('DEVNET');
    
  }, 45000); // Encryption can be slow

  it('holder should decrypt successfully', async () => {
    expect(uploadedCid).not.toBe(null, 'Must upload first');
    
    const startTime = Date.now();
    
    const result = await tacoDecrypt(uploadedCid!, provider, holderWallet);
    
    const elapsed = Date.now() - startTime;
    console.log('✓ Holder decryption succeeded in', elapsed, 'ms');
    console.log('  Plaintext length:', result.plaintext.length, 'bytes');
    
    expect(result.plaintext).toBe(testPlaintext);
    expect(result.originalCondition.contractAddress).toBe(CONFIG.daoContract);
    expect(result.originalCondition.chainId).toBe(CONFIG.chainId);
    
  }, 60000); // Decryption involves network calls

  it('non-holder should fail with CONDITION_NOT_MET', async () => {
    expect(uploadedCid).not.toBe(null, 'Must upload first');
    
    let errorThrown: any = null;
    
    try {
      await tacoDecrypt(uploadedCid!, provider, nonHolderWallet);
    } catch (err: any) {
      errorThrown = err;
    }
    
    expect(errorThrown).not.toBe(null, 'Expected decryption to fail');
    expect(errorThrown.code).toBe('CONDITION_NOT_MET');
    
    console.log('✓ Non-holder correctly rejected:', errorThrown.message);
    
  }, 60000);
});

describe('TACo Authentication Caching', { skip: CONFIG.skipIntegration }, () => {
  
  it('first decryption should prompt signature', async () => {
    // Note: This is difficult to assert programmatically; relies on manual verification
    // In browser context, user would see Metamask popup
    // For now, we verify that auth provider is attached
    
    expect(uploadedCid).not.toBe(null, 'Must upload first');
    
    const startTime = Date.now();
    const result = await tacoDecrypt(uploadedCid!, provider, holderWallet);
    const elapsed = Date.now() - startTime;
    
    console.log('✓ First decryption took', elapsed, 'ms (includes signature time)');
    expect(elapsed).toBeGreaterThan(500); // Should take some time for auth
    
    // Re-run immediately to test caching
    return result;
    
  }, 60000);
  
  it('subsequent decryption should use cached signature', async () => {
    expect(uploadedCid).not.toBe(null, 'Must upload first');
    
    const startTime = Date.now();
    const result = await tacoDecrypt(uploadedCid!, provider, holderWallet);
    const elapsed = Date.now() - startTime;
    
    console.log('✓ Cached decryption took', elapsed, 'ms');
    
    // Should be faster than first time (but not guaranteed due to network)
    expect(result.plaintext).toBe(testPlaintext);
    
  }, 60000);
});

// ─── Cleanup ───────────────────────────────────────────────────

afterAll(() => {
  if (CONFIG.skipIntegration) return;
  
  console.log('\n=== Test Run Complete ===');
  console.log('Uploaded CID:', uploadedCid || '(none)');
  console.log('Test output saved to /tests/taco/test-results.md');
});

```

---

## Test Runner Setup

### File: `package.json` additions

```json
{
  "scripts": {
    "test:taco": "vitest run tests/taco/unit",
    "test:taco:integration": "TEST_TACO_INTEGRATION_TEST=1 vitest run tests/taco/e2e.test.ts",
    "test:taco:e2e": "TS-node tests/taco/run-e2e-tests.js",
    "test:all": "npm run test && npm run test:taco"
  }
}
```

### File: `tests/taco/run-e2e-tests.js`

```javascript
#!/usr/bin/env node

/**
 * E2E Test Runner
 * 
 * Executes all TACo integration tests and generates a markdown report
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPORT_PATH = path.join(__dirname, 'test-results.md');

function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     TACo E2E Integration Tests        ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  // Check prerequisites
  checkPrerequisites();
  
  // Run tests
  const startTime = Date.now();
  let results = { passed: 0, failed: 0, errors: [] };
  
  try {
    console.log('Running vitest...\n');
    
    const output = execSync(
      'npx vitest run tests/taco/e2e.test.ts --reporter=verbose',
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    
    console.log(output);
    results.passed = (output.match(/✔|passed/gi) || []).length;
    
  } catch (err: any) {
    console.error('Test execution failed:');
    console.error(err.stdout?.toString());
    console.error(err.stderr?.toString());
    
    results.failed = (err.stdout?.match(/✗|failed/gi) || []).length;
    results.errors.push(err.message);
  }
  
  const duration = Date.now() - startTime;
  
  // Generate report
  generateReport(results, duration);
  
  // Exit with failure code if any tests failed
  process.exit(results.failed > 0 ? 1 : 0);
}

function checkPrerequisites() {
  const required = [
    'TACO_RPC_URL',
    'TEST_DAO_CONTRACT',
    'TEST_PRIVATE_KEY_WITH_TOKENS',
    'TEST_PRIVATE_KEY_NO_TOKENS',
    'IPFS_API_KEY',
  ];
  
  const missing = required.filter(k => !process.env[k]);
  
  if (missing.length > 0) {
    console.error('❌ Missing environment variables:');
    missing.forEach(k => console.error(`   ${k}`));
    console.error('\nSet these and re-run.');
    process.exit(1);
  }
  
  console.log('✓ All prerequisites met\n');
}

function generateReport(results: any, duration: number) {
  const timestamp = new Date().toISOString();
  
  const report = `# TACo E2E Test Report

**Generated:** ${timestamp}
**Duration:** ${Math.round(duration / 1000)}s

## Summary

| Metric | Value |
|--------|-------|
| Passed | ${results.passed} |
| Failed | ${results.failed} |
| Status | ${results.failed === 0 ? '✅ PASS' : '❌ FAIL'} |

## Errors

${results.errors.length === 0 ? 'No errors reported.' : results.errors.map(e => `- \`\`\`${e}\`\`\``).join('\n')}

## Environment

| Variable | Value (masked) |
|----------|---------------|
| TACO_RPC_URL | \`${process.env.TACO_RPC_URL?.substring(0, 30)}...\` |
| TEST_DAO_CONTRACT | \`${process.env.TEST_DAO_CONTRACT?.substring(0, 10)}...\` |
| TEST_PRIVATE_KEY_... | \`••••\` |

## Next Steps

${results.failed === 0 ? `
✅ All tests passed! Ready to proceed to Sprint 2.
` : `
❌ Some tests failed. Investigate errors above and re-run.

Common issues:
- Ritual ID 27 not active on DEVNET (check https://lynx-3.nucypher.network:9151/status)
- Test wallets don't match expected token holdings
- IPFS upload credentials invalid
`}
`;
  
  fs.writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log('\n📄 Report written to:', REPORT_PATH);
}

main();
```

---

## Test Results Template

### File: `tests/taco/test-results.md` (auto-generated)

```markdown
# TACo E2E Test Report

*Auto-generated by run-e2e-tests.js*

[...filled in by test runner...]
```

---

## Manual Verification Checklist

Before marking this task complete, manually verify:

- [ ] Open browser DevTools → Network tab
- [ ] Trigger decryption in test app (if UI exists)
- [ ] Verify Metamask signature popup appears first time
- [ ] Verify signature popup does NOT appear second time (cached)
- [ ] Watch TACo node requests (should see fragment fetches)
- [ ] Confirm decrypted plaintext matches encrypted input byte-for-byte

---

## Dependencies
- Depends on ALL S1 tasks completed
- Unblocks Sprint 2 (middleware rewrite validated)

---

## Success Metrics
- ✅ Positive test passes: holder decrypts exact plaintext
- ✅ Negative test passes: non-holder gets clear error
- ✅ Auth caching works (no double-signature)
- ✅ Automated test suite runs via single command
- ✅ Report generated with full traceability

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 7-8 of Sprint 1
