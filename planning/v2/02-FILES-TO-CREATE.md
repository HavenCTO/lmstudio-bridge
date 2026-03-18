# V2 Plan — Files to Create

> Complete interface designs for every new file.

---

## 1. `src/lib/archive-builder.ts` — Batch-Level IPLD Builder

**Purpose:** Builds batch-level IPLD structures. One flat dag-cbor block per conversation, one batch root block linking them all, assembled into a standard CARv1 file.

**Replaces:** `ipld-builder.ts` (per-message DAG builder + custom CAR construction)

### Types

```typescript
import { CID } from "multiformats/cid";

// ── Conversation Block (1 per conversation, stored as dag-cbor) ──

export interface ArchiveConversation {
  id: string;                          // requestId
  timestamp: number;
  model: string;
  request: {
    messages: Array<{
      role: string;
      content: string | unknown[];
      name?: string;
    }>;
    parameters?: {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stream?: boolean;
      [key: string]: unknown;
    };
  };
  response: {
    id: string;
    model: string;
    created: number;
    choices: Array<{
      index: number;
      message: { role: string; content: string };
      finish_reason: string;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  encrypted?: boolean;
  encryptedPayload?: Uint8Array;       // if encrypted, replaces request+response
}

// ── Batch Root Block (1 per batch) ──

export interface BatchRoot {
  version: "2.0.0";
  schemaVersion: "conversation-archive/2.0.0";
  batchId: number;
  timestamp: number;
  previousBatch: CID | null;          // provenance chain link
  conversations: CID[];               // links to conversation blocks
  conversationCount: number;
  metadata: {
    shimVersion: string;
    captureWindow: {
      start: number;                   // earliest conversation timestamp
      end: number;                     // latest conversation timestamp
    };
    totalTokens: number;
    models: string[];                  // unique models in this batch
  };
}

// ── Build Result ──

export interface ArchiveResult {
  carBytes: Uint8Array;                // complete CARv1 file
  rootCid: CID;                        // CID of the BatchRoot block
  conversationCids: Map<string, CID>;  // requestId → conversation CID
  blockCount: number;
  totalSize: number;
}
```

### Functions

```typescript
/**
 * Build a complete batch archive from raw conversations.
 * 
 * 1. For each conversation: dag-cbor encode → SHA-256 → CID → store block
 * 2. Build batch root with CID links to all conversations
 * 3. Assemble all blocks into a standard CARv1 file via @ipld/car
 * 
 * @returns ArchiveResult with CAR bytes, root CID, and per-conversation CIDs
 */
export async function buildBatchArchive(
  conversations: ArchiveConversation[],
  batchId: number,
  shimVersion: string,
  previousBatchCid: CID | null
): Promise<ArchiveResult>;

/**
 * Verify a CAR file's integrity.
 * Re-hashes every block and checks CID matches.
 * Verifies batch root links match contained conversation blocks.
 * 
 * @returns { valid: boolean, errors: string[] }
 */
export async function verifyArchive(
  carBytes: Uint8Array
): Promise<{ valid: boolean; errors: string[] }>;

/**
 * Extract all conversation blocks from a CAR file.
 * Returns the batch root and a map of CID → decoded ArchiveConversation.
 * Used by the exporter.
 */
export async function readArchive(
  carBytes: Uint8Array
): Promise<{
  root: BatchRoot;
  rootCid: CID;
  conversations: Map<string, ArchiveConversation>;  // CID string → conversation
}>;
```

### Implementation Notes

- Uses `@ipld/dag-cbor` for encoding (smaller, faster, native CID type, standard for Filecoin)
- Uses `@ipld/car` `CarWriter` for standard CARv1 assembly
- Uses `multiformats/hashes/sha2` for SHA-256
- `readArchive()` uses `@ipld/car` `CarReader` to parse — replaces the custom CAR parser in the old `FileBlockStore`
- No `BlockStore` interface needed — `readArchive()` returns decoded data directly

### Why dag-cbor instead of dag-json?

| | dag-json | dag-cbor |
|---|---------|---------|
| Size | Larger (JSON text) | ~30-50% smaller (binary) |
| Parse speed | Slower | Faster |
| CID linking | `{"/": "bafy..."}` convention | Native CID type |
| Filecoin standard | No | **Yes** |
| Human readable | Yes | No (but tooling exists) |

For archival, dag-cbor is the correct choice. Data is not meant to be human-readable in storage — the exporter converts to human-readable formats.

---

## 2. `src/lib/dedup-cache.ts` — Content-Hash Deduplication

**Purpose:** Simple in-memory Set of content hashes. Prevents re-archiving identical conversations.

**Replaces:** `cid-cache.ts` (SQLite CID cache) + `prompt-cache.ts` (system prompt cache)

### Types

```typescript
export interface DedupCache {
  /** Check if content hash has been seen */
  has(contentHash: string): boolean;
  /** Add a content hash */
  add(contentHash: string): void;
  /** Number of entries */
  size(): number;
  /** Clear all entries */
  clear(): void;
}
```

### Functions

```typescript
/**
 * Create a dedup cache.
 * Simple in-memory Set — no SQLite, no TTL, no deal status tracking.
 * 
 * @param maxEntries - Maximum entries before LRU eviction (default: 50000)
 */
export function createDedupCache(maxEntries?: number): DedupCache;

/**
 * Compute a content hash for deduplication.
 * SHA-256 of canonical JSON: { model, messages, response.choices }.
 * 
 * This is the ONLY hash computed on the hot path (if dedup is enabled).
 * It does NOT require building any IPLD structures.
 */
export async function computeContentHash(
  request: { model: string; messages: unknown[] },
  response: { choices: unknown[] }
): Promise<string>;
```

### Implementation Notes

- Pure in-memory — no SQLite dependency
- LRU eviction when `maxEntries` exceeded (delete oldest 10%)
- `computeContentHash()` uses `JSON.stringify()` for canonical form + SHA-256
- The hash is computed from the semantic content (model + messages + choices), not from IPLD encoding
- This replaces three separate dedup mechanisms:
  1. `prompt-cache.ts` — system prompt → CID dedup
  2. `cid-cache.ts` — root CID dedup
  3. `ipld-builder.ts` `localMessageCache` — per-builder message dedup

---

## 3. `tests/archive-builder.test.ts` — Tests for Archive Builder

**Purpose:** Unit tests for the new archive builder.

### Test Cases

```typescript
describe("archive-builder", () => {
  describe("buildBatchArchive", () => {
    it("builds a valid CAR with correct block count");
    it("creates one block per conversation plus one batch root");
    it("links batch root to all conversation CIDs");
    it("sets previousBatch to null for genesis batch");
    it("sets previousBatch CID for subsequent batches");
    it("handles encrypted conversations (encryptedPayload)");
    it("computes correct metadata (models, totalTokens, captureWindow)");
    it("produces deterministic CIDs for identical input");
  });

  describe("readArchive", () => {
    it("round-trips: build → read → verify all conversations present");
    it("decodes conversation blocks back to ArchiveConversation");
    it("returns correct batch root with all fields");
  });

  describe("verifyArchive", () => {
    it("returns valid for a correctly built archive");
    it("returns invalid if a block is tampered with");
    it("returns invalid if batch root CID links don't match");
  });
});
```

---

## 4. `tests/dedup-cache.test.ts` — Tests for Dedup Cache

**Purpose:** Unit tests for the dedup cache.

### Test Cases

```typescript
describe("dedup-cache", () => {
  it("returns false for unseen hashes");
  it("returns true for previously added hashes");
  it("evicts oldest entries when maxEntries exceeded");
  it("computeContentHash produces consistent hashes");
  it("computeContentHash produces different hashes for different content");
});
```

---

## 5. `tests/llava-exporter-v2.test.ts` — Tests for Simplified Exporter

**Purpose:** Integration tests for the v2 exporter reading v2 CARs.

### Test Cases

```typescript
describe("llava-exporter v2", () => {
  it("exports conversations from a v2 CAR to JSONL");
  it("maps user messages to 'human' role");
  it("maps assistant messages to 'gpt' role");
  it("handles system messages");
  it("handles multi-part content (text + image_url)");
  it("includes response choices as gpt turns");
  it("writes valid JSONL (one JSON object per line)");
});
```

---

## File Summary

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/lib/archive-builder.ts` | ~200 | Batch IPLD builder + CAR assembly + reader |
| `src/lib/dedup-cache.ts` | ~80 | Content-hash dedup (in-memory) |
| `tests/archive-builder.test.ts` | ~200 | Archive builder tests |
| `tests/dedup-cache.test.ts` | ~60 | Dedup cache tests |
| `tests/llava-exporter-v2.test.ts` | ~150 | Exporter integration tests |
| **Total new** | **~690** | |
