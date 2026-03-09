# S2-T1: Archive Lit Protocol Middleware Code

**Owner:** Backend Engineer  
**Estimated Effort:** 0.5 days  
**Dependencies:** Sprint 1 complete (PoC validated)  
**Acceptance Criteria:**
- [ ] Lit Protocol code moved to `.archive` directory
- [ ] Import statements in `src/index.ts` updated/removed
- [ ] Git history preserved (moved, not deleted)
- [ ] Clear documentation of what was archived and why
- [ ] Build succeeds after archival (excluding Lit-specific features)

---

## Technical Specification

### What Gets Archived

The following files contain Lit Protocol v8-specific code that is being replaced by TACo:

| File | Reason for Archival | Action |
|------|---------------------|--------|
| `src/middleware/lit-encrypt.ts` (if exists) | Replaced by `taco-encrypt.ts` | Move to archive |
| `src/utils/lit-client.ts` | Lit client wrapper | Move to archive |
| `src/utils/lit-conditions.ts` | Lit ACC builders | Move to archive |
| `src/middleware/encrypt.ts` | FULL REWRITE needed | Keep original in archive, create new file |

### Archive Directory Structure

```
src/
├── middleware/
│   ├── encrypt.ts              # NEW: TACo-based implementation (created later)
│   └── lit-encrypt.ts.archive  # OLD: Lit-v8 implementation (archived here)
├── utils/
│   ├── taco-client.ts          # NEW: TACo SDK wrapper
│   ├── taco-encryption.ts      # NEW: Encryption logic
│   ├── taco-decryption.ts      # NEW: Decryption logic
│   ├── taco-conditions.ts      # NEW: Condition builders
│   │
│   └── .archive/
│       ├── lit-client.ts.orig
│       ├── lit-conditions.ts.orig
│       └── README.md           # Explanation of what's archived
```

---

## Implementation Steps

### Step 1: Create Archive Directories

```bash
mkdir -p src/middleware/.archive
mkdir -p src/utils/.archive
```

### Step 2: Move Lit-Specific Files

```bash
# If these files exist
mv src/middleware/encrypt.ts src/middleware/.archive/lit-encrypt-original.ts
mv src/utils/lit-client.ts src/utils/.archive/ 2>/dev/null || true
mv src/utils/lit-conditions.ts src/utils/.archive/ 2>/dev/null || true
```

Note: We keep `src/middleware/encrypt.ts` but will **rewrite it completely**. The original goes to archive.

### Step 3: Update Archive README

**File:** `src/middleware/.archive/README.md`

```markdown
# Archived Lit Protocol v8 Implementation

**Archived on:** 2026-03-09  
**Reason:** Replaced by TACo (Threshold Access Control) integration  
**Migration ticket:** S2-T1 → S2-T3  

## What's Here

- `lit-encrypt-original.ts`: Original Lit v8 encryption middleware
- `lit-client.js.orig`: Lit client wrapper (if exists)
- Related test files (if any)

## Why Archived

TACo provides:
- Better condition flexibility (composite conditions, custom context vars)
- Active development (DEVNET domain for bleeding-edge features)
- SIWE-native authentication (EIP-4361 built-in)
- No server-side infrastructure requirements

Lit Protocol limitations we're moving away from:
- Naga v8 SDK stability concerns
- Less flexible condition builder API
- Different auth model (AuthManager vs EIP4361AuthProvider)

## Data Migration

**IMPORTANT:** Existing data encrypted with Lit v8 is NOT MIGRATED.

All payloads encrypted using the Lit implementation will FAIL to decrypt after this change. This has been communicated to Product/Legal as an accepted risk.

Users expecting to access old data must do so BEFORE deployment of this migration.

## Rollback Procedure

If urgent rollback needed:
1. `git checkout HEAD~1 -- src/middleware/encrypt.ts`
2. Restore package.json to previous version (re-install Lit deps)
3. Deploy previous build artifact

See `/planning/ORCHESTRATOR.md` for full rollback plan.

## Developer Notes

Original implementation notes found in:
- `/docs/decryption-spec.md` (still valid; only encryption layer changed)
- Lit SDK docs: https://dev.litprotocol.com (reference only)
```

### Step 4: Update Package.json Comment

Add comment to dependencies section explaining removal:

```json
{
  "dependencies": {
    // TACo (Threshold Access Control) - REPLACED Lit Protocol v8
    "@nucypher/taco": "devnet",
    "@nucypher/taco-auth": "latest",
    
    // Lit Protocol packages REMOVED - see src/middleware/.archive/README.md
    // "@lit-protocol/auth": "^8.2.3",      [DELETED]
    // "@lit-protocol/constants": "^9.0.1", [DELETED]
    // ...
  }
}
```

### Step 5: Verify Build

```bash
npm run build
npm test  # Non-Lit tests should pass
```

Expected output:
```
✓ Compiled successfully
✗ ERROR: '@lit-protocol' module not found (expected - migrating to TACo)
```

This error is expected until TACo middleware is implemented in S2-T3.

---

## Git Strategy

Use git mv (move with history preservation):

```bash
git add src/middleware/.archive/
git commit -m "archive: Move Lit Protocol v8 implementation to .archive

- Archiving original encrypt.ts as part of TACo migration
- Legacy encrypted data will NOT be compatible
- See /planning/Sprint2/01-lit-removal.md for details"
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Accidentally deleting untested code | Use `mv`, not `rm`; verify before committing |
| Missing hidden Lit dependencies | Search entire codebase for `@lit-protocol` imports |
| Breaking existing builds | Stage all changes; verify build passes before merging |
| Loss of encryption spec knowledge | Document key design decisions in `/docs/TACO-MIGRATION-NOTES.md` |

---

## Verification Checklist

Before marking complete:

- [ ] Archive directories created
- [ ] Original files moved, not deleted
- [ ] Archive README explains context for future developers
- [ ] Build step documents missing modules (expected errors)
- [ ] Test suite runs (non-Lit tests pass)
- [ ] Git commit includes explanatory message
- [ ] Product team notified that old data is unrecoverable

---

## Success Metrics

- ✅ Full git history preserved
- ✅ No orphaned references to Lit SDK remain
- ✅ Developers understand WHY code was archived (docs clear)
- ✅ Repository state clean; no compilation errors beyond expected

---

## Dependencies

- Depends on Sprint 1 completion (PoC validates TACo approach)
- Unblocks S2-T2 through S2-T6 (middleware rewrite can begin cleanly)

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 1 of Sprint 2
