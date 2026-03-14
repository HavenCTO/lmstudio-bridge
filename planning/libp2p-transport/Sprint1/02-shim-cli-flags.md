# S1-T2: Add Libp2p CLI Flags to the Shim

**Owner:** Backend Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S1-T1 (IPFS API client utility must exist for type imports)  
**Acceptance Criteria:**
- [ ] `--libp2p` flag added to shim CLI (mutually exclusive with `--http` and `--webrtc`)
- [ ] `--libp2p-protocol <name>` flag added (default: `/x/llmshim`)
- [ ] `--ipfs-api-url <url>` flag added (default: `http://127.0.0.1:5001`)
- [ ] When `--libp2p` is passed, the shim selects the libp2p transport path
- [ ] Validation: `--libp2p-protocol` must start with `/x/`
- [ ] `--help` output updated to document new flags
- [ ] `npm run build` succeeds

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - This task is pure TypeScript/commander changes — no IPFS interaction needed
> - Testing is manual CLI verification and build checks only — no Kubo daemon required
> - The stub for `--libp2p` will exit with a "not yet implemented" message (S1-T3 adds the real transport)

---

## Technical Specification

### Target File

```
src/index.ts
```

### CLI Changes (commander)

Add the following options to the existing `program` definition:

```typescript
// ── Libp2p transport options ──
.option("--libp2p", "Use libp2p transport (IPFS p2p tunnel)", false)
.option(
  "--libp2p-protocol <name>",
  "Libp2p protocol name for the tunnel",
  "/x/llmshim"
)
.option(
  "--ipfs-api-url <url>",
  "Kubo IPFS daemon HTTP RPC API URL",
  "http://127.0.0.1:5001"
)
```

### Transport Selection Logic

Update the existing transport selection to handle three modes:

```typescript
// Current:
const transport = opts.webrtc ? "webrtc" : "http";

// New:
let transport: "http" | "webrtc" | "libp2p";
if (opts.libp2p) {
  transport = "libp2p";
} else if (opts.webrtc) {
  transport = "webrtc";
} else {
  transport = "http";
}
```

### Validation Rules

1. **Mutual exclusivity** — If more than one of `--http`, `--webrtc`, `--libp2p` is set, exit with an error:
   ```
   Error: Only one transport mode can be active. Choose --http, --webrtc, or --libp2p.
   ```

2. **Protocol format** — `--libp2p-protocol` must start with `/x/` (Kubo requirement for custom protocols):
   ```
   Error: --libp2p-protocol must start with /x/ (e.g., /x/llmshim)
   ```

3. **URL format** — `--ipfs-api-url` should be a valid HTTP URL (basic check).

### Updated opts Type

Add to the existing opts type union:

```typescript
// Libp2p
libp2p: boolean;
libp2pProtocol: string;
ipfsApiUrl: string;
```

### Transport Startup Stub

For now, add a placeholder branch that will be filled in by S1-T3:

```typescript
if (transport === "libp2p") {
  console.log(`[main] starting libp2p transport...`);
  // TODO: S1-T3 — implement createLibp2pTransport
  console.error("[main] ✗ libp2p transport not yet implemented");
  process.exit(1);
}
```

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `src/index.ts` | MODIFY | Add CLI flags, update transport selection logic |

---

## Testing Plan

### Manual Verification (no Kubo required)

```bash
# Should show new flags in help
node dist/index.js --help

# Should print "starting libp2p transport..." then exit with stub message
node dist/index.js --libp2p

# Should use custom protocol
node dist/index.js --libp2p --libp2p-protocol /x/mymodel

# Should fail validation
node dist/index.js --libp2p --libp2p-protocol badname

# Should fail: mutually exclusive
node dist/index.js --http --libp2p
```

### Build Verification

```bash
npm run build  # Must succeed with no TypeScript errors
```

---

## Success Metrics

- ✅ `--libp2p`, `--libp2p-protocol`, `--ipfs-api-url` appear in `--help`
- ✅ Mutual exclusivity validation works
- ✅ Protocol name validation works
- ✅ Build succeeds
- ✅ Existing `--http` and `--webrtc` behaviour unchanged
- ✅ No IPFS/Kubo binary needed to develop or test this task

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 3 of Sprint 1
