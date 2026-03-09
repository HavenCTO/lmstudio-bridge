# TACo Migration Orchestrator

**Project:** Lit Protocol → TACo Migration  
**Agent ID:** Generated per-session  
**Target Network:** TACo DEVNET (lynx)  
**Ritual ID:** 27 (Open Ritual, 2-of-3 cohort)  
**Timeline:** 6-8 weeks  
**Team:** 4 engineers (1 FE, 1 BE, 1 Infra, 1 QA) + Product + Legal

---

## Executive Summary (1-Pager for Product/PM)

### What We're Doing
Migrating our encryption layer from Lit Protocol (Naga v8) to TACo (Threshold Access Control) for DAO token-holder gated access control. All data remains encrypted on IPFS; only DAO token holders (balance > 0) can decrypt.

### Why This Matters
- **TACo is forward-looking**: Active development, bleeding-edge features on DEVNET
- **Better condition flexibility**: Contract conditions (ERC20/ERC721 balance checks), composite conditions, custom context variables
- **SIWE-native auth**: EIP-4361 authentication built into TACo SDK
- **No server-side infrastructure**: We use TACo network; no node operation needed

### Risks & Caveats
- **DEVNET = testnet only**: Not trust-minimized; do NOT store production-sensitive data
- **Breaking change**: ALL existing Lit-encrypted objects become UNREADABLE (no migration path)
- **SDK version lock-in**: Must use ethers@5.7.2 (not v6) for TACo compatibility
- **New attack surface**: TACo testnet nodes operated by NuCypher team (centralized)

### Timeline Overview
| Sprint | Duration | Focus | Owner |
|--------|----------|-------|-------|
| S1 | Week 1-2 | Dependency setup, TACo PoC, encrypt/decrypt flow | BE + QA |
| S2 | Week 3-4 | Middleware rewrite, CLI integration | BE |
| S3 | Week 5-6 | Frontend decryption UI, ConditionContext integration | FE |
| S4 | Week 7-8 | Testing, logging/monitoring, docs, rollout | All + Product/Legal |

### Go/No-Go Criteria
- ✅ End-to-end: DAO token holder decrypts TACo-encrypted message on IPFS
- ✅ Negative test: Non-holder gets decryption error
- ✅ SIWE signature required and verified
- ✅ Logging captures all decryption attempts (success/fail) without leaking data
- ❌ Existing Lit-encrypted data: EXPECTED LOSS (product must accept this)

---

## Sprint Breakdown

### Sprint 1: Foundation & PoC (Week 1-2)
**Goal:** Get TACo SDK installed, running, and doing basic encrypt/decrypt with DAO conditions

#### Tasks
1. [ ] **S1-T1**: Upgrade dependencies & install TACo SDK packages ([`Sprint1/S01-dependencies.md`](./Sprint1/01-dependencies.md))
2. [ ] **S1-T2**: Implement TACo tenant initialisation and ritual verification ([`Sprint1/S02-taco-init.md`](./Sprint1/02-taco-init.md))
3. [ ] **S1-T3**: Create DAO token-holder condition builder (ERC20/ERC721 balance check) ([`Sprint1/S03-dao-condition.md`](./Sprint1/03-dao-condition.md))
4. [ ] **S1-T4**: Client-side encryption function (messageKit → JSON wrapper → IPFS) ([`Sprint1/S04-taco-encrypt.md`](./Sprint1/04-taco-encrypt.md))
5. [ ] **S1-T5**: Client-side decryption function (IPFS → messageKit → ConditionContext → decrypt) ([`Sprint1/S05-taco-decrypt.md`](./Sprint1/05-taco-decrypt.md))
6. [ ] **S1-T6**: Integration tests: positive (holder decrypts), negative (non-holder fails) ([`Sprint1/S06-integration-tests.md`](./Sprint1/06-integration-tests.md))

**Deliverables at end of Sprint 1:**
- Working TypeScript functions: `tacEncrypt()`, `tacDecrypt()`
- CLI tool or test script verifying full cycle
- Test results logged in `/tests/taco-poc-results.md`

---

### Sprint 2: Backend Middleware Rewrite (Week 3-4)
**Goal:** Replace Lit Protocol middleware with TACo-based implementation

#### Tasks
1. [ ] **S2-T1**: Archive Lit middleware code (`src/middleware/lit-encrypt.ts.archive`) ([`Sprint2/S01-lit-removal.md`](./Sprint2/01-lit-removal.md))
2. [ ] **S2-T2**: Implement TACo key encryption/recovery helper class ([`Sprint2/S02-taco-key-wrap.md`](./Sprint2/02-taco-key-wrap.md))
3. [ ] **S2-T3**: Rewrite `createEncryptMiddleware()` using TACo APIs ([`Sprint2/S03-middleware-rewrite.md`](./Sprint2/03-middleware-rewrite.md))
4. [ ] **S2-T4**: Update CLI options: remove `--lit-network`, add `--taco-domain --taco-ritual-id` ([`Sprint2/S04-cli-changes.md`](./Sprint2/04-cli-changes.md))
5. [ ] **S2-T5**: Update encryption metadata schema (add tacoDomain, ritualId, conditionType) ([`Sprint2/S05-metadata-schema.md`](./Sprint2/05-metadata-schema.md))
6. [ ] **S2-T6**: Backend unit tests for middleware logic ([`Sprint2/S06-backend-tests.md`](./Sprint2/06-backend-tests.md))

**Deliverables at end of Sprint 2:**
- `src/middleware/taco-encrypt.ts` (new implementation)
- `src/index.ts` updated with Taco CLI flags
- Passing backend test suite (`npm run test:backend`)

---

### Sprint 3: Frontend Decryption Integration (Week 5-6)
**Goal:** Frontend UI for users to authenticate (SIWE) and decrypt TACo-encrypted content

#### Tasks
1. [ ] **S3-T1**: Install TACo SDK + taco-auth in frontend package.json ([`Sprint3/S01-fe-setup.md`](./Sprint3/01-fe-setup.md))
2. [ ] **S3-T2**: Implement EIP4361AuthProvider wrapper component/hooks ([`Sprint3/S02-siwe-auth.md`](./Sprint3/02-siwe-auth.md))
3. [ ] **S3-T3**: Create `TacoDecryptor` hook/service with caching logic ([`Sprint3/S03-decryptor-hook.md`](./Sprint3/03-decryptor-hook.md))
4. [ ] **S3-T4**: Build decryption UI (button → signature request → show result/error) ([`Sprint3/S04-decryption-ui.md`](./Sprint3/04-decryption-ui.md))
5. [ ] **S3-T5**: Smart contract wallet support (EIP1271AuthProvider conditional routing) ([`Sprint3/S05-eip1271-support.md`](./Sprint3/05-eip1271-support.md))
6. [ ] **S3-T6**: Frontend integration tests with Playwright ([`Sprint3/S06-fe-e2e-tests.md`](./Sprint3/06-fe-e2e-tests.md))

**Deliverables at end of Sprint 3:**
- User-facing decryption flow working in staging environment
- Cached signature support (reauth within 2 hours)
- Smart contract wallet fallback handling

---

### Sprint 4: Quality Assurance & Rollout Prep (Week 7-8)
**Goal:** Full test coverage, performance tuning, documentation, legal sign-off, production rollout plan

#### Tasks
1. [ ] **S4-T1**: Comprehensive E2E test suite (positive/negative/auth/performance) ([`Sprint4/S01-full-e2e-suite.md`](./Sprint4/01-full-e2e-suite.md))
2. [ ] **S4-T2**: Performance testing: measure TACo fragment fetch latency, implement retries/timeout ([`Sprint4/S02-performance-retries.md`](./Sprint4/02-performance-retires.md))
3. [ ] **S4-T3**: Implement decryption audit logging (success/fail/wallet/hash only) ([`Sprint4/S03-audit-logging.md`](./Sprint4/03-audit-logging.md))
4. [ ] **S4-T4**: Error handling improvements: user-friendly messages for common failures ([`Sprint4/S04-error-handling.md`](./Sprint4/04-error-handling.md))
5. [ ] **S4-T5**: Documentation: migration guide, API reference, troubleshooting ([`Sprint4/S05-documentation.md`](./Sprint4/05-documentation.md))
6. [ ] **S4-T6**: Product/legal review checkpoint; final go/no-go meeting ([`Sprint4/S06-gonogo-review.md`](./Sprint4/06-gonogo-review.md))

**Deliverables at end of Sprint 4:**
- All automated tests passing
- Observability dashboards set up
- Runbook for decryption issues
- Legal sign-off on DEVNET usage disclaimer
- **PRODUCTION ROLLOUT PLAN** executed OR **GO-LIVE DECISION** made

---

## Checklist Template (Copy for Each Sprint)

```markdown
## Sprint X: [Sprint Name]
[ ] Task 1: [Description] - Owner: [@name] - Due: [date]
    - [ ] Implementation
    - [ ] Review
    - [ ] Tests passing
    - [ ] Docs updated
[ ] Task 2: [Description] - Owner: [@name] - Due: [date]
    ...

### Sprint Complete Criteria
- [ ] All tasks marked complete
- [ ] Sprint demo successful
- [ ] Next sprint kickoff scheduled
```

---

## Code Change Map (High-Level)

### Files to Modify
| File | Change Type | Description |
|------|-------------|-------------|
| `package.json` | deps update | Remove `@lit-protocol/*`; add `@nucypher/taco@devnet @nucypher/taco-auth ethers@5.7.2` |
| `src/middleware/encrypt.ts` | FULL REWRITE | Replace `createLitKeyEncryptor()` with `createTacoKeyWrapper()` |
| `src/index.ts` | CLI options | Remove `--lit-network --wallet-address`; add `--taco-domain --dao-contract --dao-chain` |
| `docs/decryption-spec.md` | spec update | Add TACo-specific sections (ConditionContext, auth providers, messageKit format) |

### Files to Add
| File | Purpose |
|------|---------|
| `src/utils/taco-client.ts` | Taco initialisation, provider management |
| `src/utils/taco-conditions.ts` | DAO token condition builders |
| `src/utils/taco-encryption.ts` | Encrypt/decrypt orchestration |
| `src/utils/taco-auth.ts` | Auth provider factory (EIP4361/EIP1271) |
| `tests/taco/e2e.test.ts` | Full TACo integration test suite |
| `planning/sprints/**` | Sprint planning documents |

### Files to Delete (after validation)
- Old Lit-related imports/comments
- Any Lit-specific configuration files

---

## Critical Configuration Questions (Needs Answer Before Sprint 1)

1. **DAO Token Contract Address?** Provide contract address + chain ID.
   - If ERC20: what's the symbol and expected balance threshold?
   - If ERC721: which token IDs grant access?

2. **Current encryption entry point?** Where in the pipeline does `--encrypt` trigger today?
   - Confirm: `src/index.ts` line 179-211 → calls `encryptHandle.initialize()`

3. **Current auth method for Lit?** Private key injection via `HAVE_PRIVATE_KEY` env?
   - If yes: same approach for TACo (signer for SIWE)?

4. **CI/CD access?** Who manages deployment pipelines?
   - Need access to update deployment configs for new dependencies

5. **Staging environment available?** For testing before production rollout.
   - Recommend: spin up TACo-testnet (tapir, ritualId=6) instance first

---

## Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| DEVNET instability causes failed tests | M | Have TESTNET (tapir) fallback ready |
| TACo SDK breaking changes during dev | H | Pin exact versions in package.json; monitor GitHub releases |
| Ethers v5 vs v6 incompatibility | H | Lock ethers@5.7.2 across codebase; check all ethers usages |
| Frontend auth UX friction (multiple signatures) | M | Use SingleSignOnEIP4361AuthProvider if app already has SIWE |
| Decryption latency spikes (TACo node failover) | M | Implement retry/backoff; expose timeout config |
| Product/Legal reject DEVNET risk exposure | H | Prepare TESTNET alternative; document risks explicitly |
| Smart contract wallets not supported | M | Include EIP1271AuthProvider in Scope |

---

## Command Reference for QA

```bash
# Install dependencies
npm install @nucypher/taco@devnet @nucypher/taco-auth ethers@5.7.2

# Build
npm run build

# Run TACo unit tests
npm run test:taco

# Run full E2E (requires DAOTOKEN_CONTRACT, DAO_CHAIN, TEST_WALLET_1, TEST_WALLET_0)
npm run test:taco:e2e

# Start shim with TACo
node dist/index.js --http --encrypt \
  --taco-domain DEVNET \
  --dao-contract 0x... \
  --dao-chain 11155111 \
  --key-metadata ./session-metadata.json
```

---

## Sprint Meeting Cadence

| Meeting | Frequency | Attendees | Agenda |
|---------|-----------|-----------|--------|
| Sprint Kickoff | Start of each sprint | All | Review backlog, assign owners, confirm acceptance criteria |
| Daily Standup | Daily (15 min) | Engineering | Blockers, progress, cross-team dependencies |
| Mid-Sprint Check-in | Week 2/4/6/8 | Eng + Product | Demo partial work; adjust scope if needed |
| Backlog Grooming | Weekly | Eng + Product | Refine upcoming tickets, estimate effort |
| Sprint Retrospective | End of each sprint | Engineering | What went well, what to improve, action items |
| Go/No-Go Gate | End of Sprint 4 | All + Legal/Product | Final decision on production rollout |

---

## Post-Migration Validation Checklist

After all sprints complete, verify these before declaring success:

- [ ] `tacoEncrypt("secret")` produces messageKit
- [ ] MessageKit wrapped in JSON with condition metadata survives IPFS roundtrip
- [ ] `tacoDecrypt()` with valid DAO token holder wallet succeeds
- [ ] `tacoDecrypt()` with non-holder wallet fails with clear error
- [ ] SIWE signature prompt appears for first-time decryption
- [ ] Subsequent decryptions cache signatures (no re-prompt within 2hr)
- [ ] Smart contract wallet (EIP1271) can decrypt if holding tokens
- [ ] Audit logs capture attempt without exposing plaintext or ciphertext
- [ ] All original Lit protocol references removed from codebase
- [ ] CI/CD pipeline installs new dependencies without errors
- [ ] Production deployment succeeds in staging environment
- [ ] Legal sign-off obtained on DEVNET disclaimer

---

**Document Version:** 1.0  
**Last Updated:** 2026-03-09  
**Status:** Ready for Sprint 1 Execution
