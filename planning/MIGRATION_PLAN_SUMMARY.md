# TACo Migration - Executive Summary & Follow-Up Questions

**Date:** March 9, 2026  
**Version:** 1.0  
**Status:** Ready for Execution Review

---

## One-Page Executive Summary (For Product/PM/Legal)

### What We're Doing

Migrating the DataDAO encryption layer from **Lit Protocol (Naga v8)** to **TACo (Threshold Access Control)** for DAO token-holder gated access control. All encrypted data remains on IPFS; only users holding DAO tokens can decrypt content via threshold cryptography.

### The Business Context

**Current State:** Data is encrypted with Lit Protocol, which requires ownership of a specific wallet address to decrypt. This limits our ability to implement flexible gating (e.g., "any token holder" vs "specific wallet").

**Target State:** TACo enables conditional decryption based on on-chain state (e.g., "user holds ≥ 1 DAO token"). This unlocks features like:
- Membership-gated content (token holder = access)
- Multi-token membership models (ERC20 OR ERC721)
- Multi-chain DAO support
- More sophisticated access rules (time-bound, composite conditions)

### Why This Matters

| Benefit | Description | Impact |
|---------|-------------|--------|
| **Advanced gating** | Token balance checks, NFT ownership, composite conditions | Enables membership-based monetization |
| **Active development** | DEVNET domain = bleeding-edge features | Future-proof integration |
| **SIWE-native auth** | EIP-4361 message signing built-in | Standard Web3 UX (connect wallet + sign) |
| **No server infrastructure** | Use TACo decentralized network | No ops burden, no single point of failure |

### **CRITICAL RISKS & DECISIONS**

#### ❌ Breaking Change: Existing Encrypted Data Will Be LOST

**All payloads encrypted under Lit Protocol become UNREADABLE after migration.**

We have made a conscious decision to **NOT migrate** existing Lit-encrypted data because:
- Technical complexity: Would require decrypting ALL old data → re-encrypting (requires Lit credentials + active Lit network)
- Cost-benefit tradeoff: Estimated 10-20 hours dev effort vs. value of historical data
- **Product/Owner decision required:** If legacy data has business value, we must pause and design migration strategy

✅ Acceptable if: Old data can be archived/not migrated without impact  
❌ Critical blocker if: Historical data is legally required or core to user experience

#### ⚠️ Testnet Limitations (DEVNET)

We're building against **TACo DEVNET** (lynx), which means:
- **Not trust-minimized**: Nodes operated by NuCypher team (centralized testnet)
- **No production guarantees**: Service availability, latency, consistency not SLA-backed
- **Data sensitivity warning**: Do NOT store real sensitive/PII on DEVNET

**Options:**
1. Proceed with DEVNET for MVP; plan migration to mainnet later
2. Use TESTNET (tapir, ritualId=6) = slightly more stable but same risk profile
3. Request custom mainnet ritual = higher cost, longer setup time

Recommendation: **Option 1** (DEVNET for dev/testing; defer mainnet until after PMF validation)

### Timeline Overview

| Sprint | Duration | Goal | Delivered |
|--------|----------|------|-----------|
| **Sprint 1** | Week 1-2 | PoC: TACo SDK, encrypt/decrypt flow | Working TypeScript functions |
| **Sprint 2** | Week 3-4 | Backend middleware rewrite | Drop-in replacement for Lit middleware |
| **Sprint 3** | Week 5-6 | Frontend UI + SIWE integration | User-facing decryption flow |
| **Sprint 4** | Week 7-8 | QA, logging, docs, rollout prep | Production-ready deployment |

**Total estimated duration:** 6-8 weeks with 4 engineers (1 FE, 1 BE, 1 infra, 1 QA)

### Success Criteria (Go/No-Go)

Before deploying to production, we validate:

- ✅ **Positive test:** DAOToken holder successfully decrypts TACo-encrypted content
- ✅ **Negative test:** Non-holder receives clear error (no partial data leaked)
- ✅ **Auth verification:** SIWE signature required and validated by TACo nodes
- ✅ **MessageKit portability:** Ciphertext stored on IPFS, retrievable across clients
- ✅ **Audit trail:** Decryption attempts logged (success/fail/wallet, NOT plaintext)
- ✅ **Product/legal sign-off:** Risks understood, legacy data loss accepted

### Resource Requirements

| Role | Time Commitment | Key Responsibilities |
|------|-----------------|----------------------|
| Backend Engineer | Full-time (Sprints 1-2) | Middleware rewrite, CLI updates, testing |
| Frontend Engineer | Full-time (Sprint 3) | Decryption UI, SIWE auth, caching |
| Infra/DevOps | Part-time (throughout) | CI/CD pipeline, staging environment setup |
| QA Engineer | Part-time (Sprints 1, 2, 4) | Test plans, automation, manual validation |
| Product Manager | Weekly syncs | Prioritization, feature scope, go/no-go decisions |
| Legal/Compliance | 2 checkpoints | Risk review, data handling disclaimer |

### Budget/Cost Implications

- **Development cost:** ~$60k-$80k (4 engs × 8 weeks, assuming blended rate)
- **Infra cost:** Negligible (use public TACo nodes + IPFS gateways)
- **Opportunity cost:** Legacy data becomes inaccessible (product must accept)
- **Future mainnet cost:** TBD upon ritual creation (~$X/month for cohort maintenance)

### Recommendations to Stakeholders

1. **Approve legacy data loss** (document acceptance in PRD update)
2. **Confirm target DAO token contract** (address + chain ID needed before Sprint 1)
3. **Review/testnet disclaimer language** (Legal to approve user-facing warning)
4. **Schedule weekly syncs** (Mon 10am: progress review, blockers, priorities)
5. **Plan rollback strategy** (deploy to staging first; monitor for 48hrs before prod)

### Decision Log Required

| Decision | Owner | Deadline | Status |
|----------|-------|----------|--------|
| Accept legacy data will be lost | Product/Owner | Before S1 start | ⏳ Pending |
| Approve DEVNET usage (testnet only) | Product + Legal | Before S1 start | ⏳ Pending |
| Provide DAO token contract + chain | Product | Day 3 of S1 | ⏳ Pending |
| Confirm team availability (4 engs) | Engineering Mgr | Before S1 start | ⏳ Pending |

---

## Concrete Example Artifacts

### Example 1: Encrypt Flow

```typescript
// See /planning/CODE_SNIPPETS.md for full runnable example

const messageKit = await encrypt(
  provider,                    // ethers provider
  domains.DEVNET,              // TACo domain
  'secret message',            // plaintext
  daoCondition,                // ContractCondition (balanceOf > 0)
  27,                          // ritualId (DEVNET Open Ritual)
  signer                       // wallet for encryptor auth
);

// Wrap for IPFS storage
const wrapper = {
  schemaVersion: 'taco-v1',
  tacoDomain: 'DEVNET',
  ritualId: 27,
  messageKit: serialize(messageKit),
  /* ... metadata fields */
};

await ipfs.add(JSON.stringify(wrapper)); // → CID
```

### Example 2: Decrypt Flow

```typescript
// See /planning/CODE_SNIPPETS.md for full runnable example

// Fetch from IPFS
const wrapper = await ipfs.get(cid);
const messageKit = deserialize(wrapper.messageKit);

// Setup auth
const conditionContext = ConditionContext.fromMessageKit(messageKit);
const authProvider = new EIP4361AuthProvider(provider, signer);
conditionContext.addAuthProvider(':userAddress', authProvider);

// Decrypt (prompts SIWE signature if not cached)
const plaintext = await decrypt(
  provider,
  domains.DEVNET,
  messageKit,
  conditionContext
);
```

### Example 3: IPFS JSON Schema

```json
{
  "schemaVersion": "taco-v1",
  "tacoDomain": "DEVNET",
  "ritualId": 27,
  "chainId": 1,
  "contractAddress": "0xDAO...",
  "conditionType": "ERC20Balance",
  "messageKit": { "<serialized TACo data>" }
}
```

Full examples: Refer to `/planning/CODE_SNIPPETS.md`

---

## Critical Follow-Up Questions (Need Answers Before Sprint 1)

Please provide responses to these questions during kickoff planning:

### 1. DAO Token Configuration

**Q1.1:** What is the DAO token contract address?  
**Q1.2:** Which EVM chain does it live on? (e.g., Ethereum mainnet = 1, Polygon = 137)  
**Q1.3:** Token type: ERC20 (fungible) or ERC721 (NFT)?  
**Q1.4:** If ERC721: Do we allow ANY token from collection, or specific token IDs?  
**Q1.5:** Is multi-chain token support needed now, or deferred to Phase 2?

*Impact:* Determines condition builder implementation and early architecture choices.

---

### 2. Current Encryption Entry Point Audit

**Q2.1:** Where in `src/index.ts` does `--encrypt` currently trigger? (Confirm line numbers match spec)  
**Q2.2:** Are there any OTHER modules importing Lit Protocol directly (not through middleware)?  
**Q2.3:** How many unique code paths call encryption today? (Single path? Multiple?)  

*Impact:* Affects migration scope estimation; potential hidden Lit dependencies.

---

### 3. Current Authentication Method

**Q3.1:** How do we currently authenticate for Lit encryption? (Private key env var? Wallet connect?)  
**Q3.2:** Is this private key used for other things (Filecoin uploads, signing transactions)?  
**Q3.3:** For frontend decryption: Do users already have SIWE integrated? Or fresh implementation needed?

*Impact:* Determines how much auth logic can be reused vs. rewritten.

---

### 4. Infrastructure & CI/CD

**Q4.1:** Who manages CI/CD pipelines (GitHub Actions, Jenkins, etc.)?  
**Q4.2:** Can we add a staging environment for TACo testing before production deploy?  
**Q4.3:** Do we have Pinata/Web3.Storage credits configured for IPFS uploads? Or use free tier?  
**Q4.4:** Monitoring/logging: Datadog, New Relic, or open-source stack?

*Impact:* Deployment readiness and environment setup effort.

---

### 5. Legacy Data Assessment

**Q5.1:** Approximately how many Lit-encrypted records exist on IPFS? (Range estimate ok)  
**Q5.2:** Are any of these records accessed regularly (< 10% monthly engagement)?  
**Q5.3:** Legal requirement: Must all historical data remain accessible indefinitely?  
**Q5.4:** User communication: Should we notify users about deprecated content (email/in-app)?

*Impact:* Confirms or revises the "no migration" assumption; potential scope change.

---

### 6. Performance & Scaling Expectations

**Q6.1:** Expected daily decryption requests at launch? (<1K, 1K-10K, 10K+)  
**Q6.2:** Latency tolerance for decryption? (Real-time <5s acceptable, or background job ok?)  
**Q6.3:** Peak traffic patterns known? (Time-of-day spikes, event-driven surges)

*Impact:* Influences retry/backoff config, caching strategy, monitoring thresholds.

---

### 7. Testing Requirements

**Q7.1:** Manual QA coverage expectation: 100% of code paths vs. critical paths only?  
**Q7.2:** Need automated load testing before go-live?  
**Q7.3:** Staging data requirements: Mirror production volume, or synthetic data ok?

*Impact:* Sprint 4 QA effort estimation; timeline buffer needs.

---

### 8. Rollback & Incident Response

**Q8.1:** Defined RTO/RPO for encryption failures? (i.e., max downtime/data loss tolerated)  
**Q8.2:** Rollback trigger conditions? (Error rate > X%, latency > Yms)  
**Q8.3:** Incident communication plan? (Slack channel, on-call rotation, status page)

*Impact:* Deploy confidence level; contingency planning effort.

---

## Next Steps After Q&A

Once answers collected:

1. **Update risk register** with confirmed constraints
2. **Finalize sprint backlog** (refine tickets based on actual context)
3. **Lock dependency versions** (package.json pinned exactly)
4. **Create staging environment** (TACo RPC + IPFS gateway configured)
5. **Kickoff Sprint 1** (Day 1: initial dependencies + init script)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-09 | Opencode Agent | Initial comprehensive plan |

---

**Prepared by:** Opencode AI Planning Agent  
**Reviewers pending:** Engineering Lead, Product Manager, Legal Counsel  
**Target execution start:** Upon FAQ responses received
