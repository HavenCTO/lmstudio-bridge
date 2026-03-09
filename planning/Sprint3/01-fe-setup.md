# S3-T1: Install TACo SDK in Frontend Package.json

**Owner:** Frontend Engineer  
**Estimated Effort:** 0.5 days  
**Dependencies:** Sprint 2 complete (backend validated)  
**Acceptance Criteria:**
- [ ] `package.json` updated with `@nucypher/taco` and `@nucypher/taco-auth`
- [ ] Dependencies match backend versions (@nucypher/taco@devnet, ethers@5.7.2)
- [ ] `npm install` succeeds without peer dependency conflicts
- [ ] Import paths verified in React/Vue/Angler component (test file created)
- [ ] Build command (`npm run build`) succeeds with new dependencies

---

## Technical Specification

### Frontend Dependencies to Add

```json
{
  "dependencies": {
    "@nucypher/taco": "devnet",
    "@nucypher/taco-auth": "latest",
    "ethers": "5.7.2"
  }
}
```

### Compatible Versions Matrix

| Package | Version | Reason |
|---------|---------|--------|
| `@nucypher/taco` | `devnet` tag | DEVNET domain support + latest features |
| `@nucypher/taco-auth` | `latest` | SIWE providers (EIP4361AuthProvider needed) |
| `ethers` | `5.7.2` | **REQUIRED**: TACo SDK not compatible with ethers v6 |

⚠️ **Breaking Alert:** If app currently uses ethers v6, must downgrade to v5. This may affect other parts of codebase (wallet connections, transactions, etc.).

---

## Implementation Steps

### Step 1: Modify package.json

**File:** `[YOUR_FRONTEND_DIR]/package.json`

Add to `dependencies`:

```json
"TACo for threshold encryption": "@nucypher/taco devnet",
"@nucypher/taco-auth": "latest",
"ethers @5.7.2 (required by taco)": "5.7.2"
```

### Step 2: Handle ethers Downgrade (if applicable)

If current project uses ethers v6:

```bash
# Check current version
npm list ethers

# Force downgrade (may break existing code)
npm uninstall ethers
npm install ethers@5.7.2

# Run typecheck/lint
npm run lint
npm run typecheck  # Fix any breaking API changes
```

### Step 3: Verify Imports

Create test component/utility:

```typescript
// src/utils/taco-import-test.ts

import { initialize, domains } from '@nucypher/taco';
import { EIP4361AuthProvider } from '@nucypher/taco-auth';
import { ethers } from 'ethers';

console.log('TACo imports successful');
console.log('DEVNET domain:', domains.DEVNET);

export async function verifyTacoSetup() {
  await initialize();
  return true;
}
```

Import this in a test route/page to confirm runtime initialization works.

---

## Testing Plan

### Verification Script

```bash
#!/bin/bash
echo "Checking TACo installation..."

# Check package.json has correct deps
grep -q "\"@nucypher/taco\"" package.json && echo "✓ @nucypher/taco found" || echo "✗ Missing @nucypher/taco"
grep -q "\"@nucypher/taco-auth\"" package.json && echo "✓ @nucypher/taco-auth found" || echo "✗ Missing @nucypher/taco-auth"
grep -q "\"ethers.*5.7.2\"" package.json && echo "✓ ethers@5.7.2 found" || echo "✗ Wrong ethers version"

# Try building
npm run build 2>&1 | grep -i error
if [ $? -eq 0 ]; then
  echo "❌ Build failed - investigate errors"
  exit 1
else
  echo "✅ Build succeeded"
fi

# Quick runtime check
echo "Verifying imports..."
node -e "require('@nucypher/taco').initialize().then(() => console.log('✓ TACo SDK initialized'))"
```

---

## Edge Cases & Considerations

### Web App vs Native Mobile

**React Native:** TACo WASM module may have issues on iOS/Android. Test early on target devices.

**Alternative:** Move all crypto operations to backend; expose simple REST API endpoint for decrypt requests.

### Bundle Size Impact

Adding TACo SDK increases bundle size (~2-3 MB gzipped). Consider:
- Lazy loading TACo modules (only load when user clicks "Decrypt")
- Code splitting: Separate chunk for encryption/decryption logic

### Browser Compatibility

TACo requires:
- ES2020+ support
- WebAssembly enabled
- Modern crypto APIs (SubtleCrypto)

Test on Safari 14+, Chrome 90+, Firefox 88+.

---

## Success Metrics

- ✅ No compilation errors after adding dependencies
- ✅ Runtime test confirms initialization succeeds
- ✅ Bundle analyzer shows acceptable size increase
- ✅ Linter/typecheck passes across codebase

---

## Follow-Up Questions

1. Which UI framework (React/Vue/Angular/others)? Affects hook/component implementation plan.
2. Does app already have wallet connection (MetaMask, WalletConnect)? Needed for auth provider setup.

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 1 of Sprint 3

