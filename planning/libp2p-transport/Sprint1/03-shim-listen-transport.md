# S1-T3: Implement Shim Libp2p Listen Transport

**Owner:** Backend Engineer  
**Estimated Effort:** 3 days  
**Dependencies:** S1-T1 (IPFS API client), S1-T2 (CLI flags wired up)  
**Acceptance Criteria:**
- [ ] New file `src/transport/libp2p.ts` created following the pattern of `http.ts` and `webrtc.ts`
- [ ] On start: verify IPFS daemon is running via HTTP RPC (fail fast if not)
- [ ] On start: verify `Experimental.Libp2pStreamMounting` is enabled via HTTP RPC (fail fast if not)
- [ ] On start: log the local PeerID (retrieved via HTTP RPC) so the user can share it with clients
- [ ] On start: call `p2pListen` via HTTP RPC to register the tunnel (protocol → local HTTP server)
- [ ] The shim's existing HTTP transport is used for the actual request handling (bound to `127.0.0.1`)
- [ ] The libp2p transport delegates to `createHttpTransport` internally
- [ ] Startup logs clearly show PeerID and connection instructions
- [ ] `npm run build` succeeds

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - All Kubo interaction uses the `ipfs-api.ts` utility from S1-T1 which calls `fetch()` against the HTTP RPC API
> - **Never** shell out to `ipfs` CLI — all calls go through `src/utils/ipfs-api.ts`
> - Unit tests use **mocked IPFS API functions** — no running Kubo daemon needed for development
> - Reference `kubo/docs/p2p-tunnels.md` for API behaviour documentation

---

## Technical Specification

### Target File

```
src/transport/libp2p.ts
```

### Design

The libp2p transport is a **thin wrapper** around the existing HTTP transport. The key insight from `kubo/docs/p2p-tunnels.md` is that the Kubo p2p listen API creates a local TCP socket that forwards incoming libp2p streams to a local TCP address. So:

1. Start the standard HTTP transport on `127.0.0.1:<port>` (localhost only)
2. Register a p2p listener via HTTP RPC that maps the protocol to that local address
3. Remote peers connecting via `ipfs p2p forward` will have their traffic tunneled to the local HTTP server

This means **zero changes** to request handling — all existing middleware, streaming, etc. works as-is.

### Middleware Pipeline — Fully Preserved

The entire middleware pipeline (gzip → encrypt → upload → cid-recorder) continues to process every transaction in libp2p mode. Middleware is registered on the `Engine` instance, and since the libp2p transport delegates to `createHttpTransport` which calls `engine.handleChatCompletion()`, the full middleware chain runs on every request — identical to HTTP mode. Flags like `--gzip`, `--encrypt`, `--upload` work with `--libp2p` out of the box. **No middleware modifications are needed.**

### Interface

```typescript
export interface Libp2pTransportOptions {
  /** Port for the local HTTP server that the tunnel forwards to */
  port: number;
  /** Libp2p protocol name (e.g., /x/llmshim) */
  protocol: string;
  /** Kubo HTTP RPC API URL */
  ipfsApiUrl: string;
}

const DEFAULTS: Libp2pTransportOptions = {
  port: 8080,
  protocol: "/x/llmshim",
  ipfsApiUrl: "http://127.0.0.1:5001",
};
```

### Startup Sequence

All Kubo interaction uses the `ipfs-api.ts` utility (HTTP `fetch()` calls — no CLI):

```typescript
export function createLibp2pTransport(
  engine: Engine,
  options?: Partial<Libp2pTransportOptions>
): { start: () => Promise<void> } {

  const start = async (): Promise<void> => {
    // 1. Verify IPFS daemon is running (HTTP RPC: POST /api/v0/id)
    //    → Throw IpfsDaemonNotRunningError if not reachable

    // 2. Verify Libp2pStreamMounting is enabled (HTTP RPC: POST /api/v0/config/show)
    //    → Throw Libp2pStreamMountingDisabledError if disabled

    // 3. Get and log PeerID (HTTP RPC: POST /api/v0/id)
    //    → console.log(`[libp2p] local PeerID: ${peerID}`)
    //    → console.log(`[libp2p] clients can connect using: --peerid ${peerID}`)

    // 4. Start the HTTP transport on localhost
    //    → createHttpTransport(engine, { port, host: "127.0.0.1" })
    //    → await http.start()

    // 5. Register p2p listener (HTTP RPC: POST /api/v0/p2p/listen)
    //    → await p2pListen(protocol, `/ip4/127.0.0.1/tcp/${port}`)
    //    → console.log(`[libp2p] tunnel registered: ${protocol} → 127.0.0.1:${port}`)

    // 6. Log connection instructions
    //    → Show the PeerID and protocol for client configuration
  };

  return { start };
}
```

### Multiaddr Format

Kubo expects multiaddr format for the target address:
- `/ip4/127.0.0.1/tcp/8080` — not `http://127.0.0.1:8080`

### Console Output (expected)

```
[libp2p] verifying IPFS daemon at http://127.0.0.1:5001...
[libp2p] ✓ IPFS daemon running (Kubo v0.40.0)
[libp2p] ✓ Libp2pStreamMounting enabled
[libp2p] local PeerID: 12D3KooWExAmPlE...
[libp2p] starting HTTP transport on 127.0.0.1:8080...
[http] shim listening on http://127.0.0.1:8080
[libp2p] registering p2p listener: /x/llmshim → /ip4/127.0.0.1/tcp/8080
[libp2p] ✓ tunnel active
[libp2p]
[libp2p] ═══════════════════════════════════════════════════
[libp2p]  Clients can connect with:
[libp2p]    --libp2p --peerid 12D3KooWExAmPlE...
[libp2p] ═══════════════════════════════════════════════════
```

### Wiring in `src/index.ts`

Replace the stub from S1-T2:

```typescript
import { createLibp2pTransport } from "./transport/libp2p";

// ...

if (transport === "libp2p") {
  console.log(`[main] starting libp2p transport...`);
  const libp2p = createLibp2pTransport(engine, {
    port: parseInt(opts.port, 10),
    protocol: opts.libp2pProtocol,
    ipfsApiUrl: opts.ipfsApiUrl,
  });
  await libp2p.start();
}
```

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `src/transport/libp2p.ts` | CREATE | New libp2p listen transport |
| `src/index.ts` | MODIFY | Wire up libp2p transport creation |

---

## Testing Plan

### Unit Tests (`tests/transport/libp2p.test.ts`)

**All tests use mocked `src/utils/ipfs-api.ts` functions** — no IPFS daemon or Kubo binary is required.

Mock `src/utils/ipfs-api.ts` functions:

1. **Happy path** — daemon running, feature enabled, p2pListen succeeds → transport starts
2. **Daemon not running** — throws `IpfsDaemonNotRunningError`
3. **Feature disabled** — throws `Libp2pStreamMountingDisabledError`
4. **Protocol in use** — throws `P2PProtocolInUseError`
5. **Verify HTTP transport is created with `host: "127.0.0.1"`** — important for security (no external binding)

### How to Run Tests

```bash
npm test                     # Runs all unit tests (no Kubo required)
npm run build                # Verify TypeScript compiles
```

---

## Success Metrics

- ✅ Shim starts with `--libp2p` and registers a p2p listener via HTTP RPC
- ✅ PeerID is prominently logged for user to share
- ✅ HTTP transport is bound to `127.0.0.1` only (not `0.0.0.0`)
- ✅ Fail-fast errors for missing daemon / disabled feature
- ✅ Unit tests pass (all using mocked HTTP, no Kubo needed)
- ✅ No shell-outs to `ipfs` CLI anywhere in the code

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 5 of Sprint 1
