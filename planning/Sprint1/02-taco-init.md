# S1-T2: Implement TACo Tenant Initialisation and Ritual Verification

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** S1-T1 (dependencies installed)  
**Acceptance Criteria:**
- [ ] `initialize()` function called successfully before any TACo operations
- [ ] DEVNET domain constant accessible (`domains.DEVNET`)
- [ ] Ritual ID 27 verified as active/open on DEVNET
- [ ] WASM module initialization does not crash in target environments (Node.js 18+)
- [ ] Error handling for failed initialization (with clear error messages)

---

## Technical Specification

### TACo Library Initialisation Pattern

```typescript
import { initialize, domains } from '@nucypher/taco';

// MUST be called before any other taco functions
await initialize();

// Verify domain is available
console.log('DEVNET domain:', domains.DEVNET);
// Output should show domain metadata (chain IDs, network endpoint info)
```

### Ritual Verification

On DEVNET (lynx), we use **ritualId = 27**, which is:
- An **Open Ritual** (no encryptor allowlist required)
- **2-of-3 cohort** (minimum 2 of 3 nodes must respond)
- Uses **Sepolia L1** (chain ID 11155111)
- Uses **Polygon Amoy L2** (chain ID 80002)

Verification command (manual check via browser or API):
```bash
# Check TACo network status
curl https://lynx-3.nucypher.network:9151/status | jq .
```

Expected response includes:
- Active rituals list
- Ritual 27 status = "Active"
- Coordinator contract address

### Error Handling Strategies

| Error Scenario | Detection | Recovery Action |
|----------------|-----------|-----------------|
| WASM initialisation timeout | Promise rejects after 10s | Retry once; then abort with clear error |
| Network unavailable | fetch() fails | Use cached network config; alert monitoring |
| Invalid ritual ID | decrypt() throws "invalid ritual" | Log to /docs/TACO_RITUAL_ISSUES.md; escalate |
| Domain not supported | domains.DEVNET undefined | Fall back to TESTNET (not recommended for dev) |

---

## Implementation Details

### File Creation: `src/utils/taco-client.ts`

```typescript
/**
 * TACo SDK Client Wrapper
 * 
 * Handles:
 * - TACo library initialization
 * - Provider management for various chains
 * - Ritual verification
 */

import { initialize, domains } from '@nucypher/taco';
import { providers } from 'ethers';

// Devnet configuration constants
export const TACO_DOMAIN = domains.DEVNET;
export const TACO_DEVMET_RITUAL_ID = 27;

// Supported RPC endpoints for condition evaluation
export const RPC_ENDPOINTS = {
  // EVM chains that TACo nodes can query for conditions
  ethereum: process.env.TACO_ETHEREUM_RPC || 'https://ethereum-rpc.publicnode.com',
  sepolia: process.env.TACO_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
  polygon: process.env.TACO_POLYGON_RPC || 'https://polygon-rpc.com',
  amoy: process.env.TACO_MOY_RPC || 'https://rpc-amoy.polygon.technology',
};

let initialized = false;
let tacoInstance: any = null;

/**
 * Initialize TACo SDK (WASM module + network connections)
 */
export async function initTaco(): Promise<void> {
  if (initialized) return;
  
  try {
    console.log('[taco] Initializing TACo SDK...');
    
    // Set timeout for initialization
    const initPromise = initialize();
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('TACo initialization timeout')), 10000)
    );
    
    await Promise.race([initPromise, timeoutPromise]);
    
    initialized = true;
    console.log('[taco] TACo SDK initialized successfully');
    
  } catch (error) {
    console.error('[taco] Failed to initialize:', error);
    throw new Error(
      `[taco] Initialization failed. Are you sure @nucypher/taco@devnet is installed? ` +
      `Error: ${error instanceof Error ? error.message : error}`
    );
  }
}

/**
 * Get a JSON RPC provider for a specific chain
 */
export function getProviderForChain(chain: string): providers.JsonRpcProvider {
  const rpcUrl = RPC_ENDPOINTS[chain as keyof typeof RPC_ENDPOINTS];
  if (!rpcUrl) {
    throw new Error(`[taco] No RPC endpoint configured for chain: ${chain}`);
  }
  return new providers.JsonRpcProvider(rpcUrl);
}

/**
 * Verify that a ritual exists and is active on the configured domain
 */
export async function verifyRitualExists(ritualId: number): Promise<boolean> {
  try {
    // This is a heuristic check; actual validation happens during encrypt/decrypt
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    // Query public coordinator status endpoint
    const response = await fetch('https://lynx-3.nucypher.network:9151/status', {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.warn('[taco] Could not verify ritual status (network unreachable)');
      return false;
    }
    
    const status = await response.json();
    // The response structure may vary; this is illustrative
    const active = status.active_rituals?.includes(ritualId);
    
    if (!active) {
      console.warn(`[taco] Ritual ${ritualId} not found in active rituals list`);
    }
    
    return active;
  } catch (error) {
    console.warn(`[taco] Ritual verification failed (non-fatal):`, error);
    return false; // Non-fatal; proceed anyway, let encryption fail if really broken
  }
}
```

---

## Testing Plan

### Unit Test: Initialization
```typescript
// tests/taco/initialization.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { initTaco, TACO_DOMAIN, verifyRitualExists } from '../../src/utils/taco-client';

describe('TACo Initialization', () => {
  beforeAll(async () => {
    await initTaco();
  }, 15000); // Allow time for WASM load

  it('should initialize without errors', () => {
    expect(TACO_DOMAIN).toBeDefined();
  });

  it('should have DEVNET domain properties', () => {
    expect(TACO_DOMAIN.chainId).toBeDefined();
  });

  it('should verify ritual 27 (best-effort)', async () => {
    const exists = await verifyRitualExists(27);
    // Non-fatal assertion; warn if false but don't fail test
    if (!exists) {
      console.warn('⚠️ Ritual 27 not verifiable (may be transient network issue)');
    }
  }, 10000);
});
```

### Integration Test: Pre-requisite Check
```javascript
// tests/taco/init-integration.test.js
const { initTaco, TACO_DEVMET_RITUAL_ID, TACO_DOMAIN } = require('../../dist/utils/taco-client');

async function main() {
  console.log('\n=== TACo Initialization Integration Test ===\n');
  
  try {
    console.log('Step 1: Calling initTaco()...');
    await initTaco();
    console.log('✓ TACo initialized\n');
    
    console.log('Step 2: Checking domain metadata...');
    console.log('  Domain:', TACO_DOMAIN);
    console.log('✓ Domain available\n');
    
    console.log('Step 3: Target ritual ID...');
    console.log(`  Ritual: ${TACO_DEVNET_RITUAL_ID}`);
    console.log('  Expected: 27 (DEVNET Open Ritual)\n');
    
    console.log('✅ All initialization checks passed');
    process.exit(0);
  } catch (err) {
    console.error('❌ Initialization failed:', err.message);
    console.error('\nTroubleshooting:');
    console.error('  1. Run: npm install @nucypher/taco@devnet');
    console.error('  2. Ensure Node.js >= 18');
    console.error('  3. Check internet connection (WASM downloads on first run)');
    process.exit(1);
  }
}

main();
```

---

 ## Edge Cases & Considerations

### SSR / Serverless Compatibility
TACo uses WebAssembly for cryptographic operations. In some serverless environments (Vercel, Cloudflare Workers), WASM support may be limited.

**Mitigation:** Document environment requirements; suggest deploying to Node.js-compatible hosting.

### Timeout Configuration
Initialization can take 5-15 seconds on first run (WASM download). Subsequent runs are faster due to caching.

**Action:** Expose `TACO_INIT_TIMEOUT` env var for tuning.

---

## Dependencies on Other Tasks
- Requires S1-T1 to complete first (packages installed)
- Blocks S1-T3 (condition builder needs working taco client)
- Blocks S1-T4 (encryption needs initialized taco)

---

## Success Metrics
- ✅ `initTaco()` resolves within 15 seconds
- ✅ No unhandled promise rejections during initialization
- ✅ `TACO_DOMAIN` object has expected structure
- ✅ Tests pass in both Node.js and CI environment

---

## Follow-up Questions
1. Should we add retry logic at the initialization level, or let callers handle retries?
2. Do we need pre-warming of WASM cache in production deployments?

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 3 of Sprint 1
