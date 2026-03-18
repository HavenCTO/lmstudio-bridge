# V2 Plan — Dependency Changes

> Exact changes to `package.json` dependencies.

---

## Dependencies to Add

```json
{
  "@ipld/dag-cbor": "^9.0.0"
}
```

**Why:** dag-cbor is the standard IPLD codec for Filecoin. Smaller, faster, and has native CID type support. Used by `archive-builder.ts` for encoding conversation blocks and batch roots.

> **Note:** `@ipld/car` is already in `package.json` at `^5.0.0`. No change needed.

---

## Dependencies to Remove

### From `dependencies`

```json
{
  "@ipld/dag-json": "^10.0.0",
  "ipns": "^9.0.0"
}
```

**`@ipld/dag-json` removal rationale:**
- Currently used by: `ipld-builder.ts`, `cid-utils.ts`, `registry.ts`, `llava-exporter.ts`, `cid-verify.ts`, `session-chain.ts`, `conversation-index.ts`
- After v2: None of these files exist or use dag-json anymore
- `archive-builder.ts` uses `@ipld/dag-cbor` instead
- `cid-utils.ts` only needs `multiformats` (already a dependency)
- **No backwards compatibility** means no need to keep dag-json for reading old CARs

**`ipns` removal rationale:**
- Currently used by: `ipns-manager.ts` (which is being deleted)
- No other file imports from `ipns`

### From `optionalDependencies`

```json
{
  "better-sqlite3": "^9.6.0"
}
```

**`better-sqlite3` removal rationale:**
- Currently used by: `cid-cache.ts`, `prompt-cache.ts`, `session-chain.ts`, `conversation-index.ts`, `ipns-manager.ts`
- After v2: All of these files are deleted
- The new `dedup-cache.ts` is pure in-memory (no SQLite)
- The new `registry.ts` uses JSON file persistence (no SQLite)
- This also removes the corresponding `@types/better-sqlite3` devDependency

### From `devDependencies`

```json
{
  "@types/better-sqlite3": "^7.6.12"
}
```

**Rationale:** No more SQLite usage anywhere in the codebase.

---

## Dependencies to Keep (Unchanged)

| Dependency | Used By | Notes |
|-----------|---------|-------|
| `@ipld/car` ^5.0.0 | `archive-builder.ts` | Standard CAR reader/writer — replaces hand-rolled CAR in `ipld-builder.ts` |
| `multiformats` ^13.4.2 | `archive-builder.ts`, `cid-utils.ts`, `dedup-cache.ts` | CID, SHA-256, codecs |
| `commander` 14.0.3 | `src/index.ts` | CLI framework |
| `express` 5.2.1 | `src/transport/http.ts` | HTTP server |
| `ethers` 5.7.2 | `src/middleware/taco-encrypt.ts` | Ethereum wallet for TACo |
| `@nucypher/taco` | `src/middleware/taco-encrypt.ts` | TACo encryption |
| `@nucypher/taco-auth` | `src/middleware/taco-encrypt.ts` | TACo auth |
| `@lmstudio/sdk` ^1.5.0 | `src/pipeline/translator.ts` | LM Studio SDK |
| `parquetjs-lite` ^0.8.7 | `src/middleware/cid-recorder.ts` | Parquet file writing |
| `uuid` 13.0.0 | Various | UUID generation |

### Optional Dependencies to Keep

| Dependency | Used By |
|-----------|---------|
| `filecoin-pin` ^0.16.0 | `src/middleware/upload.ts` (Synapse SDK) |
| `node-datachannel` 0.32.1 | `src/transport/webrtc.ts` |

---

## Dependencies to Evaluate

### `cborg`

**Current status:** Not in `package.json` directly, but used as a transitive dependency by `@ipld/dag-json` and imported directly in `ipld-builder.ts` for the custom CAR construction (`import("cborg")`).

**After v2:** The custom CAR construction is deleted. `@ipld/car` handles CAR encoding internally. `cborg` is still a transitive dependency of `@ipld/dag-cbor` and `@ipld/car`, but we don't need to import it directly.

**Action:** No change needed — it's not a direct dependency.

---

## Final `package.json` Dependencies Section

```json
{
  "dependencies": {
    "@ipld/car": "^5.0.0",
    "@ipld/dag-cbor": "^9.0.0",
    "@lmstudio/sdk": "^1.5.0",
    "@nucypher/taco": "0.7.0-alpha.12",
    "@nucypher/taco-auth": "0.4.0-alpha.12",
    "commander": "14.0.3",
    "ethers": "5.7.2",
    "express": "5.2.1",
    "multiformats": "^13.4.2",
    "parquetjs-lite": "^0.8.7",
    "uuid": "13.0.0"
  },
  "devDependencies": {
    "@jest/globals": "^30.3.0",
    "@types/express": "5.0.6",
    "@types/jest": "^29.5.14",
    "@types/node": "25.3.0",
    "jest": "^29.7.0",
    "jest-util": "^30.2.0",
    "ts-jest": "^29.4.6",
    "ts-node": "10.9.2",
    "typescript": "5.9.3"
  },
  "optionalDependencies": {
    "filecoin-pin": "^0.16.0",
    "node-datachannel": "0.32.1"
  }
}
```

### Net Change Summary

| Action | Package | Reason |
|--------|---------|--------|
| ✅ Add | `@ipld/dag-cbor` ^9.0.0 | Standard Filecoin codec |
| ❌ Remove | `@ipld/dag-json` ^10.0.0 | No backwards compat needed |
| ❌ Remove | `ipns` ^9.0.0 | IPNS manager deleted |
| ❌ Remove | `better-sqlite3` ^9.6.0 | All SQLite consumers deleted |
| ❌ Remove | `@types/better-sqlite3` ^7.6.12 | No more SQLite |
| **Net** | **+1 / -4** | **Simpler dependency tree** |
