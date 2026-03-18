# V2 Plan — Files to Delete

> Every file listed here is removed entirely. No code is preserved from these files.

---

## Source Files to Delete

### 1. `src/lib/ipld-builder.ts` (340 lines)

**What it does:** Builds a granular per-message IPLD DAG (message → request → response → metadata → conversation root) using dag-json codec. Also contains the hand-rolled `createCAR()` function with custom binary format.

**Why delete:** 
- The per-message DAG structure provides zero value — nobody traverses it
- The custom CAR format is non-standard (incompatible with `ipfs dag import`)
- Replaced entirely by `src/lib/archive-builder.ts` which builds flat conversation blocks + standard CAR via `@ipld/car`

**What references it:**
- `src/middleware/upload.ts` — imports `createIPLDBuilder`, `createCAR`, `IPLDBuilder`
- `src/export/llava-exporter.ts` — uses the IPLD types (IPLDMessage, IPLDRequest, etc.) to traverse the DAG
- `tests/ipld-builder.test.ts` — unit tests
- `tests/e2e-ipld-flow.ts` — e2e test

---

### 2. `src/lib/streaming-ipld.ts` (310 lines)

**What it does:** Creates a CID for every SSE chunk during streaming responses. Builds per-chunk IPLD blocks in real-time.

**Why delete:**
- Streaming responses are accumulated into complete responses before archival
- Per-chunk CIDs provide zero value — nobody retrieves individual chunks by CID
- Adds ~100 SHA-256 hashes per streaming response on the hot path for no benefit

**What references it:**
- Nothing in the current codebase actually imports this file (it was built speculatively)

---

### 3. `src/lib/prompt-cache.ts` (280 lines)

**What it does:** SQLite/in-memory cache mapping system prompt content → CID. Enables deduplication of system prompts across conversations at the per-message CID level.

**Why delete:**
- Per-message CIDs are eliminated in v2 — there's nothing to deduplicate at message level
- Replaced by conversation-level content-hash dedup in `src/lib/dedup-cache.ts`
- The SQLite dependency (`better-sqlite3`) for this single feature is overkill

**What references it:**
- `src/middleware/upload.ts` — imports `createPromptCache` type for `UploadMiddlewareOptions.promptCache`
- `src/lib/ipld-builder.ts` — imports `PromptCache` type for `BuildOptions.promptCache`

---

### 4. `src/lib/cid-cache.ts` (260 lines)

**What it does:** SQLite/in-memory cache for CID deduplication. Tracks deal status, TTL, and metadata per CID.

**Why delete:**
- Keyed by root CID (which requires building the full IPLD DAG first to compute)
- Replaced by `src/lib/dedup-cache.ts` which is keyed by content hash (computable from raw JSON without any IPLD work)
- The deal status tracking is unused — nothing ever calls `updateDealStatus()`

**What references it:**
- `src/middleware/upload.ts` — imports `CIDCache` for dedup checks

---

### 5. `src/lib/cid-verify.ts` (280 lines)

**What it does:** Fetches content from IPFS gateways and verifies CID integrity. Includes gateway fallback, batch fetch, and DAG traversal with verification.

**Why delete:**
- Gateway fetch is not used anywhere in the running system
- DAG traversal verification assumes the old per-message DAG structure
- Verification logic for the new v2 format is trivial (re-hash block, compare CID) and lives in `archive-builder.ts`

**What references it:**
- Nothing in the running codebase imports this file

---

### 6. `src/lib/session-chain.ts` (350 lines)

**What it does:** SQLite-backed session chain using IPLD. Links sessions together via CID references. Tracks per-session statistics.

**Why delete:**
- Sessions are an application concern, not a storage concern
- The batch provenance chain (`previousBatch` CID link) replaces session chaining at the archival level
- Requires `better-sqlite3` for a feature that's not used by any consumer

**What references it:**
- Nothing in `src/index.ts` or the middleware pipeline imports this

---

### 7. `src/lib/conversation-index.ts` (350 lines)

**What it does:** SQLite-backed searchable index of conversations with IPLD pagination. Supports query filters (model, time range, token count, text search).

**Why delete:**
- The registry already tracks all conversation CIDs per batch
- IPLD pagination (building index pages as IPLD blocks) is unused — nobody fetches index pages from IPFS
- The SQLite search functionality duplicates what the registry provides

**What references it:**
- Nothing in `src/index.ts` or the middleware pipeline imports this

---

### 8. `src/lib/ipns-manager.ts` (340 lines)

**What it does:** Stub implementation of IPNS mutable pointers. Uses fake key generation (random bytes, not real Ed25519). Stores records in SQLite.

**Why delete:**
- It's a stub — the key generation is fake, publishing is local-only
- No real IPFS node to publish to
- Can be re-added when there's an actual IPFS integration

**What references it:**
- Nothing in `src/index.ts` or the middleware pipeline imports this

---

## Test Files to Delete

### 9. `tests/ipld-builder.test.ts`

**Why:** Tests the old per-message IPLD builder which is being deleted.

### 10. `tests/e2e-ipld-flow.ts`

**Why:** End-to-end test for the old IPLD flow (build DAG → CAR → export). Will be replaced by new tests.

### 11. `tests/cid-cache.test.ts`

**Why:** Tests the old CID cache which is being replaced by dedup-cache.

---

## Summary

| File | Lines | Reason |
|------|-------|--------|
| `src/lib/ipld-builder.ts` | 340 | Replaced by archive-builder.ts |
| `src/lib/streaming-ipld.ts` | 310 | Zero value, unused |
| `src/lib/prompt-cache.ts` | 280 | Replaced by content-hash dedup |
| `src/lib/cid-cache.ts` | 260 | Replaced by dedup-cache.ts |
| `src/lib/cid-verify.ts` | 280 | Gateway fetch unused, DAG traversal obsolete |
| `src/lib/session-chain.ts` | 350 | Replaced by batch provenance chain |
| `src/lib/conversation-index.ts` | 350 | Registry provides this, IPLD pagination unused |
| `src/lib/ipns-manager.ts` | 340 | Stub with no real implementation |
| `tests/ipld-builder.test.ts` | ~200 | Tests deleted code |
| `tests/e2e-ipld-flow.ts` | ~150 | Tests deleted flow |
| `tests/cid-cache.test.ts` | ~150 | Tests deleted code |
| **Total removed** | **~3,010** | |
