# S2-T3: Client Bridge Libp2p Graceful Shutdown

**Owner:** Backend Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S2-T2 (forward transport must be implemented)  
**Acceptance Criteria:**
- [ ] On SIGINT/SIGTERM, the client bridge calls `p2pClose` via HTTP RPC to deregister the forward tunnel
- [ ] The local HTTP proxy server is closed gracefully
- [ ] `createLibp2pBridge` returns a `shutdown()` function
- [ ] Shutdown is wired into the client bridge's main process signal handlers
- [ ] If `p2pClose` fails (e.g., daemon already stopped), the error is logged but does not prevent exit
- [ ] `npm run build` succeeds in `client-bridge/`

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

### Changes to `client-bridge/src/libp2p-bridge.ts`

Update the return type of `createLibp2pBridge`:

```typescript
export function createLibp2pBridge(
  options: Libp2pBridgeOptions
): { start: () => Promise<void>; shutdown: () => Promise<void> } {
  
  let registeredProtocol: string | null = null;
  let httpServer: ReturnType<typeof express.Application.prototype.listen> | null = null;

  const start = async (): Promise<void> => {
    // ... existing startup logic from S2-T2 ...
    registeredProtocol = options.protocol;
  };

  const shutdown = async (): Promise<void> => {
    // 1. Close the local HTTP proxy server
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      console.log(`[libp2p] ✓ local HTTP proxy closed`);
      httpServer = null;
    }

    // 2. Close the p2p forward tunnel (via HTTP RPC, not CLI)
    if (registeredProtocol) {
      try {
        console.log(`[libp2p] closing p2p tunnel for ${registeredProtocol}...`);
        await p2pClose(registeredProtocol, { apiUrl: options.ipfsApiUrl });
        console.log(`[libp2p] ✓ tunnel closed`);
      } catch (err) {
        console.warn(`[libp2p] tunnel cleanup warning: ${err instanceof Error ? err.message : err}`);
      }
      registeredProtocol = null;
    }
  };

  return { start, shutdown };
}
```

### Changes to `client-bridge/src/index.ts`

Wire the shutdown into signal handlers. The existing client bridge doesn't have explicit shutdown handling, so add it:

```typescript
let bridge: { start: () => Promise<void>; shutdown: () => Promise<void> } | null = null;

if (mode === "libp2p") {
  bridge = createLibp2pBridge({ ... });
  await bridge.start();
}

// Graceful shutdown
const shutdown = async () => {
  console.log("\n[main] shutting down…");
  if (bridge) {
    await bridge.shutdown();
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

### Shutdown Order

1. Close the local HTTP proxy (stop accepting new requests)
2. Close the p2p forward tunnel via HTTP RPC (deregister from Kubo)
3. Exit the process

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `client-bridge/src/libp2p-bridge.ts` | MODIFY | Add `shutdown()`, track server and protocol |
| `client-bridge/src/index.ts` | MODIFY | Add signal handlers for graceful shutdown |

---

## Testing Plan

### Unit Tests (no Kubo required)

**All tests use mocked IPFS API functions** — no running daemon needed.

1. **Shutdown closes HTTP server** — verify `server.close()` is called
2. **Shutdown calls `p2pClose`** — mock `p2pClose`, verify called with correct protocol
3. **Shutdown is resilient** — mock `p2pClose` to throw, verify shutdown completes
4. **Shutdown is idempotent** — calling twice does not throw

### How to Run Tests

```bash
cd client-bridge
npm test                     # Runs all unit tests (no Kubo required)
npm run build                # Verify TypeScript compiles
```

---

## Success Metrics

- ✅ Both HTTP server and tunnel are cleaned up on shutdown
- ✅ Tunnel is closed via HTTP RPC (not CLI)
- ✅ Errors during cleanup are non-fatal
- ✅ Shutdown is idempotent
- ✅ Build succeeds
- ✅ No shell-outs to `ipfs` CLI anywhere in the code
- ✅ All unit tests pass with mocked HTTP, no Kubo needed

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 5 of Sprint 2
