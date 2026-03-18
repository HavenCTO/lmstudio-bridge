# V2 Plan — Files to Modify

> Exact changes needed for every existing file that survives the rewrite.

---

## 1. `src/middleware/upload.ts` — Complete Rewrite of Core Logic

**Current state:** 450 lines. Builds full IPLD DAG on the hot path, manages CID cache, prompt cache, batch processor, individual upload mode, and batch-before-upload mode.

**Target state:** ~250 lines. Hot path stores raw JSON. Background flush builds archive via `archive-builder.ts`. Single mode (batch-before-upload only).

### What Gets Removed

- All imports of `ipld-builder.ts` (`createIPLDBuilder`, `createCAR`, `IPLDBuilder`)
- All imports of `cid-cache.ts` (`CIDCache`)
- All imports of `prompt-cache.ts` (`createPromptCache`)
- All imports of `registry.ts` (`createBatchProcessor`, `BatchProcessor`, `createHAMTRegistry`)
- The entire "INDIVIDUAL UPLOAD MODE" code path (the `else` branch in `onResponse`)
- All IPLD DAG construction in `onResponse()` (builder, buildConversation, buildEncryptedConversation, getBlocks, createCAR)
- CID cache checks and updates
- Prompt cache checks and updates
- Component CID metadata (`requestCid`, `responseCid`, `messageCids`, `systemPromptCids`)
- The `BatchProcessor` integration

### What Gets Added

- Import `buildBatchArchive` from `archive-builder.ts`
- Import `createDedupCache`, `computeContentHash` from `dedup-cache.ts`
- Import simplified registry from `registry.ts`

### New `PendingConversation` Interface

```typescript
// BEFORE:
export interface PendingConversation {
  requestId: string;
  rootCid: CID;
  blocks: Map<string, Uint8Array>;
  carBytes: Uint8Array;
  request: OpenAIChatCompletionRequest;
  response: any;
}

// AFTER:
export interface PendingConversation {
  requestId: string;
  timestamp: number;
  request: OpenAIChatCompletionRequest;
  response: OpenAIChatCompletionResponse;
  encrypted: boolean;
  encryptedBuffer?: Buffer;
}
```

### New `UploadMiddlewareOptions` Interface

```typescript
// BEFORE:
export interface UploadMiddlewareOptions {
  synapseUpload: SynapseUploadFn;
  cidCache?: CIDCache;
  promptCache?: ReturnType<typeof createPromptCache>;
  batchProcessor?: BatchProcessor;
  registryPath?: string;
  batchSize?: number;
  batchBeforeUpload?: boolean;
  carDir?: string;
}

// AFTER:
export interface UploadMiddlewareOptions {
  synapseUpload: SynapseUploadFn;
  registryPath?: string;
  batchSize?: number;
  carDir?: string;
}
```

### New `onResponse()` — Zero IPLD Work

```typescript
async onResponse(payload, next) {
  const request = payload.context.metadata.capturedRequest;
  const response = payload.openaiResponse;

  // SECURITY CHECK: fail-closed encryption validation (unchanged)
  const encryptedBuffer = payload.context.metadata.encryptedBuffer;
  const pipeline = (payload.context as any).pipeline;
  const hasTacoEncrypt = pipeline?.middlewares?.some((m: any) => m.name === 'taco-encrypt');
  if (hasTacoEncrypt && !encryptedBuffer) {
    throw new Error(`[upload] SECURITY: taco-encrypt registered but no encryptedBuffer`);
  }

  // Store raw conversation for background processing
  const pending: PendingConversation = {
    requestId: payload.context.requestId,
    timestamp: Date.now(),
    request,
    response,
    encrypted: !!encryptedBuffer,
    encryptedBuffer,
  };

  batchBuffer.push(pending);

  // Check batch threshold — snapshot and enqueue (non-blocking)
  if (batchBuffer.length >= targetBatchSize) {
    const snapshot = batchBuffer.splice(0);
    flushQueueInstance.enqueue(snapshot as any, Date.now());
  }

  // Set minimal metadata
  payload.context.metadata.batchPending = true;
  payload.context.metadata.requestId = pending.requestId;

  await next();
  // ← Client gets response immediately. Zero IPLD work.
}
```

### New `flushBatch()` — All IPLD Work Here

```typescript
async function flushBatch(conversations: PendingConversation[], batchTimestamp: number) {
  if (conversations.length === 0) return;

  // 1. Convert to ArchiveConversation format
  const archiveConversations = conversations.map(conv => ({
    id: conv.requestId,
    timestamp: conv.timestamp,
    model: conv.request.model,
    request: {
      messages: conv.request.messages.map(m => ({ role: m.role, content: m.content })),
      parameters: extractParameters(conv.request),
    },
    response: {
      id: conv.response.id,
      model: conv.response.model,
      created: conv.response.created,
      choices: conv.response.choices.map(c => ({
        index: c.index,
        message: { role: c.message.role, content: c.message.content },
        finish_reason: c.finish_reason ?? "",
      })),
      usage: conv.response.usage,
    },
    encrypted: conv.encrypted,
    encryptedPayload: conv.encryptedBuffer ? new Uint8Array(conv.encryptedBuffer) : undefined,
  }));

  // 2. Build archive (IPLD blocks + CAR)
  const archive = await buildBatchArchive(
    archiveConversations,
    batchTimestamp,
    "2.0.0",
    lastBatchCid
  );

  // 3. Write CAR to disk (crash recovery)
  const batchCarDir = path.join(carDir, `batch-${batchTimestamp}`);
  await fs.mkdir(batchCarDir, { recursive: true });
  const carPath = path.join(batchCarDir, "merged.car");
  await fs.writeFile(carPath, archive.carBytes);

  // 4. Upload to Filecoin
  const result = await synapseUpload(carPath, (p) => {
    if (p.percentage % 20 === 0) console.log(`[upload] batch | ${p.percentage}%`);
  });

  // 5. Update registry
  await registry.addBatch({
    batchId: batchTimestamp,
    rootCid: archive.rootCid.toString(),
    filecoinCid: result.cid,
    conversationCids: [...archive.conversationCids.values()].map(c => c.toString()),
    carSize: archive.carBytes.length,
    conversationCount: archiveConversations.length,
    previousBatchCid: lastBatchCid?.toString() ?? null,
  });
  await registry.persist(registryPath);

  // 6. Update chain pointer
  lastBatchCid = archive.rootCid;

  // 7. Update dedup cache
  for (const conv of archiveConversations) {
    const hash = await computeContentHash(conv.request, conv.response);
    dedupCache.add(hash);
  }
}
```

### What Stays Unchanged

- `createSynapseUploader()` — Synapse SDK integration (no IPLD involvement)
- `UploadProgress`, `UploadResult`, `SynapseUploadFn` types
- `SynapseUploaderOptions` and the uploader factory
- `UploadMiddlewareHandle` interface (drainFlushes, getFlushStats)
- `onRequest()` handler (captures request for later use)
- Security check logic (fail-closed encryption validation)
- Crash recovery logic (scan for unflushed batch directories)

---

## 2. `src/export/llava-exporter.ts` — Simplified to Read Flat Blocks

**Current state:** 350 lines. Traverses IPLD DAG (root → request → messages[] → response → choices[] → message) with 8+ block fetches per conversation. Has `BlockStore` interface, `InMemoryBlockStore`, `FileBlockStore` with custom CAR parser.

**Target state:** ~150 lines. Reads flat conversation blocks from CAR files using `readArchive()`. No DAG traversal. No `BlockStore` interface. No custom CAR parser.

### What Gets Removed

- `BlockStore` interface
- `InMemoryBlockStore` class
- `FileBlockStore` class (with its custom CAR parser)
- All IPLD type definitions (`IPLDMessage`, `IPLDRequest`, `IPLDChoice`, `IPLDResponse`, `IPLDConversation`)
- `convertConversation()` method with its 8-step DAG traversal
- `@ipld/dag-json` import
- `exportBatchFromCAR()` utility function (replaced by simpler version)

### What Gets Added

- Import `readArchive`, `ArchiveConversation` from `archive-builder.ts`

### New `convertConversation()` — Single Block Read

```typescript
private convertConversation(conv: ArchiveConversation): LLaVAConversation | null {
  const turns: LLaVATurn[] = [];

  // Messages are inline — no CID traversal needed
  for (const msg of conv.request.messages) {
    const role = msg.role === "user" ? "human" : msg.role === "assistant" ? "gpt" : "human";
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    turns.push({ from: role, value: content });
  }

  // Response choices are inline too
  for (const choice of conv.response.choices) {
    turns.push({ from: "gpt", value: choice.message.content });
  }

  // Extract image if enabled
  let image = "";
  if (this.options.extractImages && this.options.imagePattern) {
    image = this.extractImageSync(turns);
  }

  return { id: conv.id, image, conversations: turns };
}
```

### New `export()` — Reads CAR Directly

```typescript
async export(carPath: string): Promise<ExportResult> {
  const carBytes = await fs.readFile(carPath);
  const { conversations } = await readArchive(carBytes);

  const results: LLaVAConversation[] = [];
  const errors: ExportError[] = [];

  for (const [cidStr, conv] of conversations) {
    try {
      const result = this.convertConversation(conv);
      if (result) results.push(result);
    } catch (error) {
      errors.push({
        conversationId: cidStr,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Write JSONL
  const jsonlPath = path.join(this.options.outputDir, `batch-${String(this.options.batchId).padStart(6, "0")}.jsonl`);
  const content = results.map(r => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "");
  await fs.writeFile(jsonlPath, content, "utf-8");

  return { jsonlPath, conversationCount: results.length, totalSize: Buffer.byteLength(content), errors };
}
```

### What Stays Unchanged

- `LLaVAConversation`, `LLaVATurn` types
- `ExportOptions`, `ExportResult`, `ExportError` types
- `ImagePattern` type and image extraction logic
- `base64ToUint8Array()`, `uint8ArrayToBase64()` utilities

---

## 3. `src/lib/registry.ts` — Simplified (Remove HAMT)

**Current state:** 280 lines. `HAMTRegistry` with `buildHAMT()`, `getHAMTRoot()`, HAMT node types, `BatchProcessor` wrapper.

**Target state:** ~120 lines. Simple JSON file registry with batch metadata and provenance chain.

### What Gets Removed

- `HAMTRegistry` interface (replaced by simpler `Registry`)
- `HAMTEntry`, `HAMTNode` types
- `buildHAMT()` method
- `getHAMTRoot()` method
- `addConversation()` method (conversations are tracked per-batch, not individually)
- `createBatchProcessor()` factory and `BatchProcessor` interface
- `calculateOptimalBatchSize()` utility
- `validateRegistry()` utility (can be re-added later if needed)

### New Interface

```typescript
export interface BatchRecord {
  batchId: number;
  rootCid: string;
  filecoinCid: string;
  conversationCids: string[];
  conversationCount: number;
  carSize: number;
  createdAt: number;
  previousBatchCid: string | null;
}

export interface RegistryState {
  version: "2.0.0";
  totalBatches: number;
  totalConversations: number;
  batches: BatchRecord[];
  lastBatchCid: string | null;
  lastUpdated: number;
}

export interface Registry {
  addBatch(record: BatchRecord): Promise<void>;
  getBatch(batchId: number): Promise<BatchRecord | null>;
  getState(): Promise<RegistryState>;
  persist(filepath: string): Promise<void>;
  load(filepath: string): Promise<void>;
}

export function createRegistry(): Registry;
```

### What Stays (Conceptually)

- JSON file persistence with atomic write (temp file + rename)
- Batch metadata tracking
- Load/persist lifecycle

---

## 4. `src/lib/cid-utils.ts` — Trim to Essentials

**Current state:** 50 lines. `generateCID()`, `generateRawCID()`, `verifyContent()`, `fetchAndVerify()`.

**Target state:** ~25 lines. Keep `generateCID()` and `generateRawCID()`. Remove gateway fetch.

### What Gets Removed

- `fetchAndVerify()` — gateway fetch is not used
- `verifyContent()` — verification is now in `archive-builder.ts`

### What Stays

- `generateCID(data)` — used by dedup-cache for content hashing
- `generateRawCID(data)` — used for raw byte hashing
- Re-exports of `CID`, `sha256`, `rawCodec`

---

## 5. `src/lib/flush-queue.ts` — No Changes

**Current state:** 180 lines. Generic serial background queue with retry, backpressure, and drain.

**Target state:** Unchanged. This is a well-designed generic queue that works perfectly for the new architecture.

---

## 6. `src/middleware/cid-recorder.ts` — Simplify Schema

**Current state:** 250 lines. Records per-message component CIDs (rootCid, requestCid, responseCid, messageCids, systemPromptCids) in Parquet format.

**Target state:** ~180 lines. Records batch-level CIDs only (rootCid, batchId). No per-message component tracking.

### What Gets Removed

- `requestCid`, `responseCid`, `messageCids`, `systemPromptCids` columns from Parquet schema
- `ConversationCIDRecord` interface with component tracking
- `buildConversationRecord()`, `serializeComponents()` helpers
- `findLinkedConversations()`, `getConversationChain()` helpers (chain is now at batch level)

### New Parquet Schema

```typescript
const CONVERSATION_SCHEMA = new ParquetSchema({
  cid: { type: "UTF8" },           // conversation CID (from archive-builder)
  batchRootCid: { type: "UTF8" },  // batch root CID
  timestamp: { type: "INT64" },
});
```

### What Stays

- Sessions Parquet file (sessions.parquet with id + metadataCid)
- Per-session conversation file
- Session ID auto-increment logic
- Basic middleware structure (onRequest passthrough, onResponse records CID)

---

## 7. `src/index.ts` — Remove Dead Imports and Simplify Options

**Current state:** 650 lines. Imports from deleted modules, passes `cidCache`, `promptCache`, `batchProcessor` to upload middleware.

### What Gets Removed

- Import of `createBatchProcessor` from `registry.ts`
- Import of `validateRegistry` from `registry.ts` (used in registry-status command)
- References to `cidCache`, `promptCache` in upload middleware creation
- The `--batch-size` description mentioning "HAMT registry"

### What Gets Changed

- Upload middleware creation simplified:
  ```typescript
  // BEFORE:
  uploadHandle = createUploadMiddleware({
    synapseUpload: synapseUploader.upload,
    registryPath: cfg.upload.registryPath,
    batchSize: cfg.upload.batchSize,
    batchBeforeUpload: true,
    carDir: "./data",
  });

  // AFTER:
  uploadHandle = createUploadMiddleware({
    synapseUpload: synapseUploader.upload,
    registryPath: cfg.upload.registryPath,
    batchSize: cfg.upload.batchSize,
    carDir: "./data",
  });
  ```

- Export command updated to use `readArchive()` instead of `FileBlockStore`
- Registry status command updated for v2 registry format (no HAMT root)
- Import of `createHAMTRegistry` → `createRegistry`
- Import of `exportBatchFromCAR` updated for new exporter API

### What Stays

- All CLI option definitions
- All transport logic (HTTP, WebRTC, libp2p)
- Client bridge logic
- TACo encryption middleware setup
- Gzip middleware setup
- Configuration system
- Graceful shutdown logic

---

## Summary

| File | Current Lines | Target Lines | Change |
|------|--------------|-------------|--------|
| `src/middleware/upload.ts` | 450 | ~250 | Rewrite core, keep Synapse uploader |
| `src/export/llava-exporter.ts` | 350 | ~150 | Rewrite to read flat blocks |
| `src/lib/registry.ts` | 280 | ~120 | Remove HAMT, simplify to JSON registry |
| `src/lib/cid-utils.ts` | 50 | ~25 | Remove gateway fetch |
| `src/lib/flush-queue.ts` | 180 | 180 | No changes |
| `src/middleware/cid-recorder.ts` | 250 | ~180 | Simplify schema |
| `src/index.ts` | 650 | ~620 | Remove dead imports, simplify options |
| **Total** | **2,210** | **~1,525** | **-685 lines** |
