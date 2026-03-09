# S1-T1: Upgrade Dependencies & Install TACo SDK Packages

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** None  
**Acceptance Criteria:**
- [ ] Lit Protocol packages removed from package.json
- [ ] TACo packages installed and verified working
- [ ] ethers downgraded/locked to v5.7.2 (required by TACo)
- [ ] `npm install` completes without peer dependency errors
- [ ] `npm run build` succeeds after changes
- [ ] Existing tests still pass (excluding Lit-specific ones)

---

## Technical Specification

### Current Dependencies (to remove)
```json
{
  "@lit-protocol/auth": "^8.2.3",
  "@lit-protocol/constants": "^9.0.1",
  "@lit-protocol/lit-client": "^8.3.1",
  "@lit-protocol/lit-node-client": "^8.0.0-alpha.0",
  "@lit-protocol/networks": "^8.4.1"
}
```

### New Dependencies (to add)
```json
{
  "@nucypher/taco": "devnet",
  "@nucypher/taco-auth": "latest",
  "ethers": "5.7.2"
}
```

### Installation Command
```bash
# Remove Lit packages
npm uninstall @lit-protocol/auth @lit-protocol/constants @lit-protocol/lit-client \
  @lit-protocol/lit-node-client @lit-protocol/networks

# Install TACo packages (devnet tag for @nucypher/taco)
npm install @nucypher/taco@devnet @nucypher/taco-auth ethers@5.7.2

# Verify installation
npm list @nucypher/taco @nucypher/taco-auth ethers
```

### Package.json Changes

#### Before (dependencies section)
```json
"dependencies": {
  "@lit-protocol/auth": "^8.2.3",
  "@lit-protocol/constants": "^9.0.1",
  "@lit-protocol/lit-client": "^8.3.1",
  "@lit-protocol/lit-node-client": "^8.0.0-alpha.0",
  "@lit-protocol/networks": "^8.4.1",
  "@lmstudio/sdk": "^1.5.0",
  "commander": "14.0.3",
  "ethers": "^6.16.0",
  "express": "5.2.1",
  "filecoin-pin": "^0.16.0",
  "node-datachannel": "0.32.1",
  "parquetjs-lite": "0.8.7",
  "uuid": "13.0.0"
}
```

#### After (dependencies section)
```json
"dependencies": {
  "@nucypher/taco": "devnet",
  "@nucypher/taco-auth": "latest",
  "@lmstudio/sdk": "^1.5.0",
  "commander": "14.0.3",
  "ethers": "5.7.2",
  "express": "5.2.1",
  "filecoin-pin": "^0.16.0",
  "node-datachannel": "0.32.1",
  "parquetjs-lite": "0.8.7",
  "uuid": "13.0.0"
}
```

### Breaking Change Alert: ethers Version

TACo SDK depends on **ethers v5.x**. Our current codebase uses **ethers v6.16.0**.

**Impact assessment:**
- `src/middleware/encrypt.ts` uses `ethers.Wallet` and `ethers.providers.Web3Provider`
- `src/index.ts` may reference ethers indirectly
- Test files use ethers for private key derivation

**Migration path (deferred to this ticket's implementation):**
```typescript
// v6 syntax (current)
import { Wallet, Provider } from "ethers";
const wallet = new Wallet(privateKey);

// v5 syntax (required)
import { Wallet, providers } from "ethers";
const wallet = new Wallet(privateKey);
const provider = new providers.JsonRpcProvider(rpcUrl);
```

### Files Likely Affected
| File | Change Required | Notes |
|------|-----------------|-------|
| `package.json` | YES | Remove/add dependencies |
| `src/middleware/encrypt.ts` | YES | Update imports if using ethers directly |
| `src/index.ts` | MAYBE | Check for ethers usage |
| `tests/*.js` | MAYBE | Update if using ethers |

---

## Implementation Steps

### Step 1: Backup current state
```bash
git checkout -b feature/taco-migration-s1
git status  # Confirm clean working directory
```

### Step 2: Modify package.json
Remove Lit packages, downgrade ethers to 5.7.2, add TACo packages.

### Step 3: Clear lockfile (if conflicts arise)
```bash
rm package-lock.json
rm -rf node_modules
npm install
```

### Step 4: Run builds and tests
```bash
npm run build
npm test  # Exclude Lit-specific tests for now
```

### Step 5: Document issues encountered
Create `/docs/TACO_DEPENDENCY_ISSUES.md` listing any peer dependency conflicts or breaking changes discovered.

---

## Testing Plan

### Unit Verification
```javascript
// tests/taco/taco-import.test.js
const taco = require('@nucypher/taco');
const auth = require('@nucypher/taco-auth');
const { ethers } = require('ethers');

describe('TACo SDK import', () => {
  it('should import taco without errors', () => {
    expect(taco).toBeDefined();
    expect(typeof taco.initialize).toBe('function');
    expect(taco.domains).toBeDefined();
    expect(taco.domains.DEVNET).toBeDefined();
  });

  it('should import taco-auth', () => {
    expect(auth.EIP4361AuthProvider).toBeDefined();
    expect(auth.USER_ADDRESS_PARAM_DEFAULT).toBe(':userAddress');
  });

  it('should have ethers v5.7.2', () => {
    const version = require('ethers/package.json').version;
    expect(version).toBe('5.7.2');
  });
});
```

### Build Verification
```bash
npm run build 2>&1 | tee /tmp/build-output.log
# Should show no TypeScript errors related to ethers API
```

---

## Rollback Plan

If dependencies cause blocking issues:

```bash
# Restore original package.json
git checkout HEAD -- package.json
npm install
npm run build  # Verify back to working state
```

---

## Success Metrics
- ✅ No peer dependency WARNINGS during npm install
- ✅ Build produces dist/ folder with no errors
- ✅ Non-Lit tests still green (baseline regression check)
- ✅ Can import `@nucypher/taco` and `@nucypher/taco-auth` in Node REPL

---

## Follow-up Questions for Product/Team

1. Are there any other modules in the repo that import Lit protocols directly? (search will be done, but confirm business logic impact)
2. Should we create a separate PR just for dependency upgrade, before making code changes?

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 2 of Sprint 1
