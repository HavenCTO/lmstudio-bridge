# S2-T1: Add Libp2p CLI Flags to the Client Bridge

**Owner:** Backend Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S1-T1 (IPFS API client utility — shared between shim and client bridge)  
**Acceptance Criteria:**
- [ ] `--libp2p` flag added to client bridge CLI (alternative to the existing WebRTC `--shim-url` flow)
- [ ] `--peerid <id>` flag added (required when `--libp2p` is used)
- [ ] `--libp2p-protocol <name>` flag added (default: `/x/llmshim`)
- [ ] `--ipfs-api-url <url>` flag added (default: `http://127.0.0.1:5001`)
- [ ] When `--libp2p` is passed, `--shim-url` is no longer required
- [ ] Validation: `--peerid` is required when `--libp2p` is set
- [ ] Validation: `--libp2p-protocol` must start with `/x/`
- [ ] `--help` output updated to document new flags
- [ ] `npm run build` succeeds in `client-bridge/`

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - This task is pure TypeScript/commander changes — no IPFS interaction needed
> - Testing is manual CLI verification and build checks only — no Kubo daemon required
> - The stub for `--libp2p` will exit with a "not yet implemented" message (S2-T2 adds the real bridge)

---

## Technical Specification

### Target File

```
client-bridge/src/index.ts
```

### CLI Changes (commander)

Add the following options to the existing `program` definition:

```typescript
// ── Libp2p transport options ──
.option("--libp2p", "Use libp2p transport (IPFS p2p tunnel)", false)
.option(
  "--peerid <id>",
  "PeerID of the remote shim (required with --libp2p)"
)
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

### Mode Selection Logic

The client bridge currently has a single mode (WebRTC via `--shim-url`). Add a second path:

```typescript
const mode = opts.libp2p ? "libp2p" : "webrtc";

if (mode === "webrtc" && !opts.shimUrl) {
  console.error("[main] ✗ --shim-url is required for WebRTC mode");
  process.exit(1);
}

if (mode === "libp2p" && !opts.peerid) {
  console.error("[main] ✗ --peerid is required when --libp2p is used");
  process.exit(1);
}
```

### Making `--shim-url` Conditionally Required

Currently `--shim-url` is a `requiredOption`. Change it to a regular `.option()` and add runtime validation:

```typescript
// Before:
.requiredOption("--shim-url <url>", "URL of the LLM shim's control server")

// After:
.option("--shim-url <url>", "URL of the LLM shim's control server (required for WebRTC mode)")
```

### Updated opts Type

```typescript
const opts = program.opts<{
  shimUrl?: string;     // Now optional (required only for WebRTC)
  port: string;
  host: string;
  signalingPort: string;
  timeout: string;
  // Libp2p
  libp2p: boolean;
  peerid?: string;
  libp2pProtocol: string;
  ipfsApiUrl: string;
}>();
```

### Transport Startup Stub

Add a placeholder branch that will be filled in by S2-T2:

```typescript
if (mode === "libp2p") {
  console.log(`[main] starting libp2p transport...`);
  console.log(`[main] connecting to PeerID: ${opts.peerid}`);
  // TODO: S2-T2 — implement libp2p forward mode
  console.error("[main] ✗ libp2p transport not yet implemented");
  process.exit(1);
}
```

### Sharing `src/utils/ipfs-api.ts` with Client Bridge

The client bridge is a separate package in `client-bridge/`. To reuse the IPFS API client from S1-T1, there are two approaches:

**Option A (recommended):** Copy the utility into `client-bridge/src/utils/ipfs-api.ts`. The file is small (~200 lines) and the client bridge is independently packaged.

**Option B:** Use a TypeScript path alias or symlink. More complex, may not be worth the coupling.

The developer should choose Option A unless there's a strong reason for shared code. Note this in the implementation.

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `client-bridge/src/index.ts` | MODIFY | Add CLI flags, mode selection, make `--shim-url` optional |
| `client-bridge/src/utils/ipfs-api.ts` | CREATE | Copy of `src/utils/ipfs-api.ts` (or import path) |

---

## Testing Plan

### Manual Verification (no Kubo required)

```bash
cd client-bridge

# Should show new flags in help
node dist/index.js --help

# Should fail: --peerid required
node dist/index.js --libp2p

# Should fail: --shim-url required for WebRTC mode (no --libp2p)
node dist/index.js

# Should print stub message and exit
node dist/index.js --libp2p --peerid 12D3KooWExAmPlE

# Should work with custom protocol
node dist/index.js --libp2p --peerid 12D3KooWExAmPlE --libp2p-protocol /x/mymodel

# Should fail validation
node dist/index.js --libp2p --peerid 12D3KooWExAmPlE --libp2p-protocol badname
```

### Build Verification

```bash
cd client-bridge && npm run build  # Must succeed
```

---

## Success Metrics

- ✅ New flags appear in `--help`
- ✅ `--peerid` validation works
- ✅ `--shim-url` is only required for WebRTC mode
- ✅ Protocol name validation works
- ✅ Build succeeds
- ✅ Existing WebRTC flow unchanged
- ✅ No IPFS/Kubo binary needed to develop or test this task

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 1 of Sprint 2
