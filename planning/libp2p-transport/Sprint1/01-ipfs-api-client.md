# S1-T1: IPFS Daemon HTTP API Client Utility

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** None (first task in the feature)  
**Acceptance Criteria:**
- [ ] New file `src/utils/ipfs-api.ts` created with typed helper functions
- [ ] `checkDaemonRunning()` — pings `/api/v0/id` and returns boolean
- [ ] `getPeerID()` — returns the local node's PeerID string
- [ ] `checkLibp2pStreamMounting()` — fetches config and verifies `Experimental.Libp2pStreamMounting === true`
- [ ] `p2pListen(protocol, targetAddr)` — calls `/api/v0/p2p/listen`
- [ ] `p2pForward(protocol, listenAddr, targetPeerID)` — calls `/api/v0/p2p/forward`
- [ ] `p2pClose(protocol?)` — calls `/api/v0/p2p/close` (optional protocol filter)
- [ ] `p2pList()` — calls `/api/v0/p2p/ls` and returns active tunnels
- [ ] All functions accept an `ipfsApiUrl` parameter (default `http://127.0.0.1:5001`)
- [ ] Unit tests cover success and failure paths for each function
- [ ] `npm run build` succeeds

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - All Kubo interaction must use `fetch()` against the HTTP RPC API — **never** shell out to `ipfs` CLI
> - All unit tests must use **mocked `fetch()` responses** — no running Kubo daemon is required
> - Reference `kubo/docs/p2p-tunnels.md` and `kubo/docs/experimental-features.md` in this repo for API behaviour documentation
> - Error messages shown to end users _may_ reference `ipfs` CLI commands (end users will have Kubo installed)

---

## Technical Specification

### Why a Dedicated Module?

Both the shim (listen mode) and the client bridge (forward mode) need to interact with the Kubo HTTP RPC API. Extracting a shared utility avoids duplication, centralises error handling, and makes mocking straightforward in tests.

### Target File

```
src/utils/ipfs-api.ts
```

### Kubo HTTP RPC Endpoints Used

All interaction happens via HTTP `POST` requests to the Kubo daemon's RPC API. The developer does not need a running Kubo instance — only needs to implement `fetch()` calls matching the API spec below. Reference the docs in `kubo/docs/` for detailed behaviour.

| Function | Kubo Endpoint | Method | Notes |
|----------|--------------|--------|-------|
| `checkDaemonRunning` | `/api/v0/id` | POST | Returns node identity; 200 = daemon running |
| `getPeerID` | `/api/v0/id` | POST | Parse `ID` field from response JSON |
| `checkLibp2pStreamMounting` | `/api/v0/config/show` | POST | Parse `Experimental.Libp2pStreamMounting` |
| `p2pListen` | `/api/v0/p2p/listen` | POST | Query params: `arg=<protocol>&arg=<target>` |
| `p2pForward` | `/api/v0/p2p/forward` | POST | Query params: `arg=<protocol>&arg=<listen>&arg=<target>` |
| `p2pClose` | `/api/v0/p2p/close` | POST | Query params: `all=true` or `protocol-id=<proto>` |
| `p2pList` | `/api/v0/p2p/ls` | POST | Optional `headers=true` for verbose output |

### Interface Design

```typescript
export interface IpfsApiOptions {
  /** Kubo HTTP RPC URL. Default: http://127.0.0.1:5001 */
  apiUrl?: string;
  /** Timeout for API calls in ms. Default: 5000 */
  timeoutMs?: number;
}

export interface PeerIdentity {
  id: string;          // PeerID (e.g., 12D3KooW...)
  publicKey: string;
  addresses: string[];
  agentVersion: string;
}

export interface P2PTunnel {
  protocol: string;
  listenAddress: string;
  targetAddress: string;
}
```

### Error Types

The module should throw typed errors that downstream code (shim, client-bridge) can catch and present as actionable messages. Error messages _may_ reference `ipfs` CLI commands since **end users** will have Kubo installed:

```typescript
export class IpfsDaemonNotRunningError extends Error {
  constructor(apiUrl: string) {
    super(`IPFS daemon not reachable at ${apiUrl}. Is Kubo running? Start with: ipfs daemon`);
    this.name = 'IpfsDaemonNotRunningError';
  }
}

export class Libp2pStreamMountingDisabledError extends Error {
  constructor() {
    super(
      'Experimental.Libp2pStreamMounting is not enabled.\n' +
      'Enable it with: ipfs config --json Experimental.Libp2pStreamMounting true\n' +
      'Then restart the IPFS daemon.'
    );
    this.name = 'Libp2pStreamMountingDisabledError';
  }
}

export class P2PProtocolInUseError extends Error {
  constructor(protocol: string) {
    super(`Protocol "${protocol}" is already in use. Close it first with: ipfs p2p close --protocol-id ${protocol}`);
    this.name = 'P2PProtocolInUseError';
  }
}
```

### Implementation Notes

- Use the built-in `fetch()` API (Node 18+) — no new dependencies needed.
- **Do NOT use `child_process`, `exec`, `spawn`, or any shell-out to `ipfs` CLI** — all interaction must be HTTP `fetch()` calls.
- Kubo's HTTP RPC uses **POST** for all endpoints, even read-only ones.
- Parameters are passed as **query strings** (not request body).
- Responses are JSON except for streaming endpoints (not used here).
- Kubo API endpoint examples (from `kubo/docs/p2p-tunnels.md`) — these show the _end-user CLI equivalents_ of what the code does via HTTP:
  - Listen: `POST http://127.0.0.1:5001/api/v0/p2p/listen?arg=/x/llmshim&arg=/ip4/127.0.0.1/tcp/8080`
  - Forward: `POST http://127.0.0.1:5001/api/v0/p2p/forward?arg=/x/llmshim&arg=/ip4/127.0.0.1/tcp/9090&arg=/p2p/$PEER_ID`
  - Close: `POST http://127.0.0.1:5001/api/v0/p2p/close?all=true`

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `src/utils/ipfs-api.ts` | CREATE | New IPFS API client utility |
| `tests/utils/ipfs-api.test.ts` | CREATE | Unit tests with mocked fetch |

---

## Testing Plan

### Unit Tests (`tests/utils/ipfs-api.test.ts`)

**All tests use mocked `global.fetch`** — no IPFS daemon or Kubo binary is required to run tests.

Mock `global.fetch` to simulate Kubo API responses:

1. **`checkDaemonRunning`** — returns `true` on 200, `false` on network error
2. **`getPeerID`** — returns PeerID string from mocked `/api/v0/id` response
3. **`checkLibp2pStreamMounting`** — returns `true` when enabled, throws `Libp2pStreamMountingDisabledError` when disabled
4. **`p2pListen`** — returns success on 200, throws `P2PProtocolInUseError` on conflict
5. **`p2pForward`** — returns success on 200, handles errors
6. **`p2pClose`** — verifies correct query params for close-all vs close-by-protocol
7. **`p2pList`** — parses tunnel list from mocked response
8. **Timeout handling** — verify `AbortSignal.timeout` is applied

### How to Run Tests

```bash
npm test                     # Runs all unit tests (no Kubo required)
npm run build                # Verify TypeScript compiles
```

---

## Success Metrics

- ✅ All 8+ unit tests pass (using mocked fetch, no Kubo needed)
- ✅ Module exports cleanly from `src/utils/ipfs-api.ts`
- ✅ No new npm dependencies added
- ✅ No shell-outs to `ipfs` CLI anywhere in the code
- ✅ TypeScript builds without errors
- ✅ Error classes produce actionable, user-friendly messages (referencing `ipfs` CLI for end users)

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 2 of Sprint 1
