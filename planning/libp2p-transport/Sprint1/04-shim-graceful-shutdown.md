# S1-T4: Shim Libp2p Graceful Shutdown

**Owner:** Backend Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S1-T3 (listen transport must be implemented)  
**Acceptance Criteria:**
- [ ] On SIGINT/SIGTERM, the shim calls `p2pClose` via HTTP RPC to deregister the tunnel before exiting
- [ ] `createLibp2pTransport` returns a `shutdown()` function in addition to `start()`
- [ ] The shutdown function is wired into the existing graceful shutdown handler in `src/index.ts`
- [ ] If `p2pClose` fails (e.g., daemon already stopped), the error is logged but does not prevent exit
- [ ] `npm run build` succeeds

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - Shutdown cleanup calls `p2pClose()` from `ipfs-api.ts` which uses `fetch()` — no CLI shell-outs
> - Unit tests use **mocked IPFS API functions** — no running Kubo daemon needed
> - You cannot verify with `ipfs p2p ls` during development; rely on unit tests to confirm correct API calls

---

## Technical Specification

### Changes to `src/transport/libp2p.ts`

Update the return type of `createLibp2pTransport` to include a shutdown function:

```typescript
export function createLibp2pTransport(
  engine: Engine,
  options?: Partial<Libp2pTransportOptions>
): { start: () => Promise<void>; shutdown: () => Promise<void> } {
  
  let registeredProtocol: string | null = null;

  const start = async (): Promise<void> => {
    // ... existing startup logic from S1-T3 ...
    registeredProtocol = opts.protocol;
  };

  const shutdown = async (): Promise<void> => {
    if (!registeredProtocol) return;

    try {
      console.log(`[libp2p] closing p2p tunnel for ${registeredProtocol}...`);
      // Uses HTTP RPC: POST /api/v0/p2p/close — no CLI shell-out
      await p2pClose(registeredProtocol, { apiUrl: opts.ipfsApiUrl });
      console.log(`[libp2p] ✓ tunnel closed`);
    } catch (err) {
      // Non-fatal — daemon may have already stopped
      console.warn(`[libp2p] tunnel cleanup warning: ${err instanceof Error ? err.message : err}`);
    }
    registeredProtocol = null;
  };

  return { start, shutdown };
}
```

### Changes to `src/index.ts`

Wire the shutdown into the existing graceful shutdown handler:

```typescript
let libp2pTransport: { start: () => Promise<void>; shutdown: () => Promise<void> } | null = null;

if (transport === "libp2p") {
  libp2pTransport = createLibp2pTransport(engine, { ... });
  await libp2pTransport.start();
}

// In the shutdown handler:
const shutdown = async () => {
  console.log("\n[main] shutting down…");

  // Existing cleanup...
  if (encryptHandle) { ... }
  if (tacoEncryptHandle) { ... }
  if (litKeyEncryptor) { ... }

  // New: close libp2p tunnel (via HTTP RPC, not CLI)
  if (libp2pTransport) {
    await libp2pTransport.shutdown();
    console.log("[main] libp2p tunnel closed");
  }

  // Existing cleanup...
  if (cidRecorder) { ... }
  if (synapseUploader) { ... }

  process.exit(0);
};
```

### Shutdown Order

The tunnel should be closed **before** other cleanup (like CID recorder, uploader) since those may not be relevant, but **after** encryption handles are destroyed (consistent with existing pattern).

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `src/transport/libp2p.ts` | MODIFY | Add `shutdown()` return, track `registeredProtocol` |
| `src/index.ts` | MODIFY | Wire `libp2pTransport.shutdown()` into shutdown handler |

---

## Testing Plan

### Unit Tests (no Kubo required)

**All tests use mocked IPFS API functions** — no running daemon needed.

1. **Shutdown calls `p2pClose`** — mock `p2pClose`, verify it's called with the correct protocol
2. **Shutdown is resilient** — mock `p2pClose` to throw, verify shutdown completes without throwing
3. **Shutdown is idempotent** — calling shutdown twice does not throw; second call is a no-op

### How to Run Tests

```bash
npm test                     # Runs all unit tests (no Kubo required)
npm run build                # Verify TypeScript compiles
```

---

## Success Metrics

- ✅ Tunnel is deregistered on clean shutdown via HTTP RPC (SIGINT, SIGTERM)
- ✅ Errors during cleanup are logged but non-fatal
- ✅ Shutdown is idempotent
- ✅ Build succeeds
- ✅ No shell-outs to `ipfs` CLI anywhere in the code
- ✅ All unit tests pass with mocked HTTP, no Kubo needed

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 6 of Sprint 1
