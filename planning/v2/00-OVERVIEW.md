# V2 Archival Architecture — Clean-Slate Rewrite

> **Date:** 2026-03-17  
> **Status:** 📋 Implementation Plan (approved)  
> **Scope:** Complete IPLD/CID/CAR redesign — no backwards compatibility  
> **Constraint:** All changes completed in a single session

---

## Key Assumption: No Backwards Compatibility

**This plan assumes zero existing data.** There are no legacy CARs to read, no v1 format to detect, no dual-path exporter. Every file that touches the old IPLD pipeline is either deleted or rewritten from scratch. The exporter only understands the new v2 format.

This dramatically simplifies the implementation compared to the v1 plan:
- No `detectFormat()` version sniffing
- No legacy DAG-traversal code path in the exporter
- No `@ipld/dag-json` dependency kept "just for v1 compat"
- No migration strategy — there's nothing to migrate

---

## What We're Building

A **tamper-evident archival system** for LLM conversations that uses IPLD/CID/CAR correctly:

| Concept | Implementation |
|---------|---------------|
| **Verification unit** | One CID per conversation (flat dag-cbor block) |
| **Storage unit** | One CAR per batch (standard CARv1 via `@ipld/car`) |
| **Provenance** | Batch chain — each batch root links to previous batch CID |
| **Hot path overhead** | Zero — raw JSON stored in memory, all crypto in background |
| **Deduplication** | Single content-hash per conversation (replaces 3-layer dedup) |
| **Export** | Load block → decode → done (no DAG traversal) |

---

## Plan Documents

| Document | Contents |
|----------|----------|
| [01-FILES-TO-DELETE.md](./01-FILES-TO-DELETE.md) | Every file to remove, with rationale |
| [02-FILES-TO-CREATE.md](./02-FILES-TO-CREATE.md) | New files with full interface designs |
| [03-FILES-TO-MODIFY.md](./03-FILES-TO-MODIFY.md) | Existing files with exact changes needed |
| [04-DEPENDENCY-CHANGES.md](./04-DEPENDENCY-CHANGES.md) | package.json additions and removals |
| [05-IMPLEMENTATION-ORDER.md](./05-IMPLEMENTATION-ORDER.md) | Step-by-step execution order for the session |

---

## Metrics: Before vs After

| Metric | Current | V2 |
|--------|---------|-----|
| Hot path IPLD overhead | ~5-20ms (12 hashes, 12 encodes) | **0ms** |
| Blocks per conversation | ~12 | **1** |
| Blocks per 10-conv batch | ~120+ | **11** |
| SHA-256 hashes per request (hot path) | ~12 | **0** |
| SHA-256 hashes per request (background) | 0 | **1** |
| Memory per pending conversation | ~50KB (blocks + carBytes) | **~5KB** (raw JSON) |
| CAR format compatibility | ❌ Custom (non-standard) | ✅ Standard CARv1 |
| Exporter block fetches per conversation | ~8 | **1** |
| Source files in IPLD pipeline | 11 | **3** |
| Lines of code in IPLD pipeline | ~2,500 | **~500** |
| Dedup layers | 3 | **1** |
| Provenance chain | ❌ None | ✅ Batch-linked |
| Backwards compat code | N/A | **None** (clean slate) |

---

## Architecture Diagram

```
═══════════════════════════════════════════════════════════════════
  HOT PATH (onResponse → return to client)
═══════════════════════════════════════════════════════════════════

  HTTP Request → LM Studio → Response
                                │
                                ▼
                    ┌─────────────────────┐
                    │  Store raw JSON     │  ← ~0ms overhead
                    │  { request,         │
                    │    response,         │
                    │    timestamp,        │
                    │    requestId }       │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Append to batch    │  ← in-memory array push
                    │  buffer             │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Batch full?        │
                    │  → snapshot & enqueue│  ← non-blocking
                    └─────────────────────┘
                              │
                    ══════════▼══════════════════════════════════
                      BACKGROUND (FlushQueue worker)
                    ═════════════════════════════════════════════
                              │
                    ┌─────────▼───────────┐
                    │  Content-hash dedup │
                    │  (skip duplicates)  │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  For each conv:     │
                    │  1. Canonical JSON   │
                    │  2. dag-cbor encode  │
                    │  3. SHA-256 → CID    │  ← 1 hash per conversation
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Build batch root:  │
                    │  { version,         │
                    │    conversations[],  │  ← CID links
                    │    previousBatch,    │  ← chain link
                    │    metadata }        │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Assemble CAR v1    │
                    │  via @ipld/car      │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Write CAR to disk  │
                    │  (crash recovery)   │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Upload to Filecoin │
                    │  via Synapse SDK    │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  Update registry    │
                    │  Update dedup cache │
                    └─────────────────────┘
```
