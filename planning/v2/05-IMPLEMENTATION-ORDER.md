# V2 Plan — Implementation Order

> Step-by-step execution order for completing all changes in a single session.  
> Each step is designed to keep the codebase compilable after completion.

---

## Guiding Principles

1. **Delete first, create second, modify third** — removing dead code before writing new code prevents confusion about what's current
2. **Bottom-up** — build leaf modules (archive-builder, dedup-cache) before the modules that depend on them (upload middleware, exporter)
3. **Tests alongside code** — write tests for each new module immediately after creating it
4. **One compilable state per step** — after each numbered step, `tsc` should pass (or at minimum, only fail on the files we haven't modified yet)

---

## Phase 1: Delete Dead Code (Steps 1-2)

### Step 1: Delete source files

Delete these 8 files:

```bash
rm src/lib/ipld-builder.ts
rm src/lib/streaming-ipld.ts
rm src/lib/prompt-cache.ts
rm src/lib/cid-cache.ts
rm src/lib/cid-verify.ts
rm src/lib/session-chain.ts
rm src/lib/conversation-index.ts
rm src/lib/ipns-manager.ts
```

**After this step:** TypeScript will fail to compile because `upload.ts`, `llava-exporter.ts`, and `index.ts` import from deleted files. This is expected — we fix them in Phase 3.

### Step 2: Delete test files for deleted code

```bash
rm tests/ipld-builder.test.ts
rm tests/e2e-ipld-flow.ts
rm tests/cid-cache.test.ts
```

---

## Phase 2: Create New Modules (Steps 3-6)

### Step 3: Update `package.json` dependencies

1. Add `@ipld/dag-cbor` to dependencies
2. Remove `@ipld/dag-json` from dependencies
3. Remove `ipns` from dependencies
4. Remove `better-sqlite3` from optionalDependencies
5. Remove `@types/better-sqlite3` from devDependencies
6. Run `npm install`

### Step 4: Create `src/lib/dedup-cache.ts`

Write the content-hash dedup cache module:
- `DedupCache` interface with `has()`, `add()`, `size()`, `clear()`
- `createDedupCache(maxEntries?)` factory
- `computeContentHash(request, response)` function

**Verify:** This module has no dependencies on other project files — only `multiformats`.

### Step 5: Create `src/lib/archive-builder.ts`

Write the batch-level IPLD builder:
- `ArchiveConversation`, `BatchRoot`, `ArchiveResult` types
- `buildBatchArchive()` — builds conversation blocks + batch root + CARv1
- `readArchive()` — parses CARv1 back to typed data
- `verifyArchive()` — re-hashes blocks and checks integrity

**Dependencies:** `@ipld/dag-cbor`, `@ipld/car`, `multiformats`

**Verify:** This module has no dependencies on other project files.

### Step 6: Create tests for new modules

Write:
- `tests/archive-builder.test.ts` — round-trip build/read/verify tests
- `tests/dedup-cache.test.ts` — basic cache behavior tests

**Verify:** `npm test -- tests/archive-builder.test.ts tests/dedup-cache.test.ts` passes.

---

## Phase 3: Modify Existing Modules (Steps 7-12)

### Step 7: Rewrite `src/lib/registry.ts`

Replace the HAMT registry with the simplified v2 registry:
- Remove `HAMTRegistry`, `HAMTEntry`, `HAMTNode`, `BatchProcessor`, `createBatchProcessor`, `calculateOptimalBatchSize`, `validateRegistry`
- Remove `@ipld/dag-json` and `multiformats` imports (no longer needed)
- Write new `Registry` interface with `addBatch()`, `getBatch()`, `getState()`, `persist()`, `load()`
- Write `createRegistry()` factory
- Keep atomic JSON file persistence

**Verify:** Module compiles standalone (no imports from deleted files).

### Step 8: Trim `src/lib/cid-utils.ts`

- Remove `verifyContent()` function
- Remove `fetchAndVerify()` function
- Remove `@ipld/dag-json` import
- Keep `generateCID()`, `generateRawCID()`, and re-exports

**Verify:** Module compiles. Only depends on `multiformats`.

### Step 9: Rewrite `src/export/llava-exporter.ts`

Complete rewrite:
- Remove all IPLD type definitions (`IPLDMessage`, `IPLDRequest`, etc.)
- Remove `BlockStore`, `InMemoryBlockStore`, `FileBlockStore` classes
- Remove DAG-traversal `convertConversation()` method
- Remove `@ipld/dag-json` import
- Import `readArchive`, `ArchiveConversation` from `archive-builder.ts`
- New `export(carPath)` method reads CAR file → `readArchive()` → flat conversion
- New `convertConversation(conv: ArchiveConversation)` — inline message/choice reading
- Keep `LLaVAConversation`, `LLaVATurn`, `ExportOptions`, `ExportResult`, `ExportError` types
- Keep image extraction logic
- Keep `base64ToUint8Array()`, `uint8ArrayToBase64()` utilities

**Verify:** Module compiles. Depends on `archive-builder.ts` (created in Step 5).

### Step 10: Rewrite `src/middleware/upload.ts`

Major rewrite of core logic:
- Remove imports: `CIDCache`, `createIPLDBuilder`, `createCAR`, `createPromptCache`, `createBatchProcessor`, `createHAMTRegistry`
- Add imports: `buildBatchArchive` from `archive-builder.ts`, `createDedupCache`/`computeContentHash` from `dedup-cache.ts`, `createRegistry` from `registry.ts`
- Simplify `PendingConversation` (remove `rootCid`, `blocks`, `carBytes`)
- Simplify `UploadMiddlewareOptions` (remove `cidCache`, `promptCache`, `batchProcessor`, `batchBeforeUpload`)
- Rewrite `onResponse()` — zero IPLD work, just store raw JSON and check batch threshold
- Rewrite `flushBatch()` — convert to `ArchiveConversation[]`, call `buildBatchArchive()`, write CAR, upload, update registry
- Remove individual upload mode (only batch mode)
- Keep: Synapse uploader, security checks, crash recovery, flush queue integration

**Verify:** Module compiles. Depends on `archive-builder.ts`, `dedup-cache.ts`, `registry.ts`, `flush-queue.ts`.

### Step 11: Simplify `src/middleware/cid-recorder.ts`

- Simplify Parquet schema (remove `requestCid`, `responseCid`, `messageCids`, `systemPromptCids`)
- Remove `ConversationCIDRecord` interface and component tracking helpers
- Remove `findLinkedConversations()`, `getConversationChain()` helpers
- Update `onResponse()` to record simplified CID data

**Verify:** Module compiles.

### Step 12: Update `src/index.ts`

- Change import: `createHAMTRegistry` → `createRegistry` from `registry.ts`
- Remove import: `createBatchProcessor`, `validateRegistry` from `registry.ts`
- Remove import: `exportBatchFromCAR`, `FileBlockStore` from `llava-exporter.ts` (if directly imported)
- Update upload middleware creation (remove `batchBeforeUpload`, `cidCache`, `promptCache` options)
- Update export command to use new exporter API (read CAR → `readArchive()`)
- Update registry-status command for v2 format (no HAMT root display)
- Remove any references to deleted modules

**Verify:** Full `tsc` compilation passes.

---

## Phase 4: Verify (Steps 13-14)

### Step 13: Run all tests

```bash
npm test
```

Fix any failures. The following test files should still pass:
- `tests/flush-queue.test.ts` — unchanged module
- `tests/registry.test.ts` — may need updates for new interface
- `tests/config.test.ts` — unchanged
- `tests/archive-builder.test.ts` — new tests
- `tests/dedup-cache.test.ts` — new tests

The following test files were deleted and should not be referenced:
- ~~`tests/ipld-builder.test.ts`~~
- ~~`tests/e2e-ipld-flow.ts`~~
- ~~`tests/cid-cache.test.ts`~~

### Step 14: Build and verify

```bash
npm run build
```

Ensure clean TypeScript compilation with zero errors.

---

## Execution Checklist

```
Phase 1: Delete Dead Code
  [ ] Step 1:  Delete 8 source files
  [ ] Step 2:  Delete 3 test files

Phase 2: Create New Modules
  [ ] Step 3:  Update package.json + npm install
  [ ] Step 4:  Create src/lib/dedup-cache.ts
  [ ] Step 5:  Create src/lib/archive-builder.ts
  [ ] Step 6:  Create tests (archive-builder, dedup-cache)

Phase 3: Modify Existing Modules
  [ ] Step 7:  Rewrite src/lib/registry.ts
  [ ] Step 8:  Trim src/lib/cid-utils.ts
  [ ] Step 9:  Rewrite src/export/llava-exporter.ts
  [ ] Step 10: Rewrite src/middleware/upload.ts
  [ ] Step 11: Simplify src/middleware/cid-recorder.ts
  [ ] Step 12: Update src/index.ts

Phase 4: Verify
  [ ] Step 13: Run all tests
  [ ] Step 14: Build and verify (tsc clean)
```

---

## Time Estimates

| Phase | Steps | Estimated Time |
|-------|-------|---------------|
| Phase 1: Delete | 1-2 | 2 minutes |
| Phase 2: Create | 3-6 | 30-45 minutes |
| Phase 3: Modify | 7-12 | 45-60 minutes |
| Phase 4: Verify | 13-14 | 10-15 minutes |
| **Total** | **14 steps** | **~90-120 minutes** |

---

## Risk Mitigation

### What if `@ipld/car` API doesn't match expectations?

The `@ipld/car` package is already in `package.json` at `^5.0.0`. The API for `CarWriter` and `CarReader` is stable. If the streaming API is awkward, we can use the simpler `CarBufferWriter` for in-memory construction.

### What if `@ipld/dag-cbor` has CID encoding issues?

dag-cbor has native CID support — CIDs are encoded as CBOR tag 42. This is the standard encoding used by Filecoin. The `@ipld/dag-cbor` package handles this automatically.

### What if tests for other modules break?

The `tests/registry.test.ts` file tests the old `HAMTRegistry` interface. It will need to be updated for the new `Registry` interface. This is expected and handled in Step 13.

### What if the Synapse uploader expects a specific CAR format?

The Synapse uploader (`createSynapseUploader`) wraps the CAR file in its own UnixFS CAR before uploading. It reads the file as raw bytes and re-packages it. The internal CAR format doesn't matter to Synapse — it just needs a valid file on disk.

---

## Files Touched Summary

| Action | Count | Files |
|--------|-------|-------|
| **Delete** | 11 | 8 source + 3 test files |
| **Create** | 5 | 2 source + 3 test files |
| **Modify** | 6 | upload.ts, llava-exporter.ts, registry.ts, cid-utils.ts, cid-recorder.ts, index.ts |
| **Unchanged** | ~30+ | All transport, pipeline, config, types, other middleware |

### Net Code Change

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Source files in IPLD pipeline | 11 | 3 | **-8** |
| Lines in IPLD pipeline | ~2,500 | ~500 | **-2,000** |
| Total source files deleted | — | 8 | — |
| Total source files created | — | 2 | — |
| Total test files deleted | — | 3 | — |
| Total test files created | — | 3 | — |
| Dependencies removed | — | 4 | — |
| Dependencies added | — | 1 | — |
