# S2-T4: Comprehensive Error Handling for Libp2p Transport

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** S1-T3 (shim listen), S2-T2 (client bridge forward)  
**Acceptance Criteria:**
- [ ] All error conditions produce actionable, user-friendly messages
- [ ] IPFS daemon not running → clear message with start instructions
- [ ] Libp2pStreamMounting not enabled → clear message with enable command
- [ ] PeerID unreachable → timeout with retry details and troubleshooting steps
- [ ] Protocol already in use → clear message with close command
- [ ] IPFS API URL unreachable (wrong URL) → clear message with URL hint
- [ ] All errors are tested with unit tests
- [ ] `npm run build` succeeds in both root and `client-bridge/`

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - All error detection happens via HTTP `fetch()` responses — no CLI shell-outs
> - Error messages shown to end users _may_ reference `ipfs` CLI commands (end users will have Kubo installed)
> - All unit tests use **mocked `fetch()` responses** — no running Kubo daemon needed
> - The code itself must never invoke `ipfs` CLI commands — only the user-facing error _messages_ may reference them

---

## Technical Specification

### Error Catalog

Every error the libp2p transport can produce, with the exact message format.

Note: Error messages reference `ipfs` CLI commands because **end users** will have Kubo installed. The **code itself** only uses HTTP `fetch()` — never CLI.

#### 1. IPFS Daemon Not Running

**When:** `checkDaemonRunning()` fetch fails (connection refused or timeout)

```
✗ IPFS daemon not reachable at http://127.0.0.1:5001

  The libp2p transport requires a running Kubo (IPFS) daemon.

  To start it:
    $ ipfs daemon

  If Kubo is not installed:
    https://docs.ipfs.tech/install/

  If your daemon uses a non-default API address:
    $ llm-shim --libp2p --ipfs-api-url http://<host>:<port>
```

**Exit code:** 1

#### 2. Libp2pStreamMounting Not Enabled

**When:** `checkLibp2pStreamMounting()` fetch returns false

```
✗ Experimental.Libp2pStreamMounting is not enabled

  The libp2p transport requires this experimental Kubo feature.

  To enable it:
    $ ipfs config --json Experimental.Libp2pStreamMounting true

  Then restart the IPFS daemon:
    $ ipfs shutdown && ipfs daemon
```

**Exit code:** 1

#### 3. PeerID Unreachable (Timeout)

**When:** Client bridge `p2pForward` via HTTP RPC succeeds but TCP connection to tunnel port times out

```
✗ PeerID 12D3KooW... is unreachable (timed out after 30s)

  Possible causes:
    • The remote shim is not running with --libp2p
    • The remote IPFS daemon is offline
    • NAT traversal failed (both peers behind symmetric NAT)

  Troubleshooting:
    1. Verify the PeerID is correct
    2. Check remote shim is running: curl http://<remote>:5001/api/v0/id
    3. Test IPFS connectivity: ipfs swarm connect /p2p/12D3KooW...
    4. Check tunnel on remote: ipfs p2p ls
```

**Exit code:** 1

#### 4. Protocol Already In Use

**When:** `p2pListen` or `p2pForward` HTTP RPC call fails because the protocol is already registered

```
✗ Protocol "/x/llmshim" is already in use

  Another listener or forwarder is using this protocol name.

  To see active tunnels:
    $ ipfs p2p ls

  To close the existing tunnel:
    $ ipfs p2p close --protocol-id /x/llmshim

  Or use a different protocol name:
    $ llm-shim --libp2p --libp2p-protocol /x/llmshim2
```

**Exit code:** 1

#### 5. IPFS API URL Wrong / Unreachable

**When:** Fetch to `/api/v0/id` returns non-JSON or unexpected status

```
✗ Could not connect to IPFS API at http://127.0.0.1:5001

  The URL may be incorrect or the daemon may be configured
  with a different API address.

  Check your daemon's API address:
    $ ipfs config Addresses.API

  Then pass it explicitly:
    $ llm-shim --libp2p --ipfs-api-url http://<host>:<port>
```

**Exit code:** 1

#### 6. Tunnel Disconnected Mid-Session (Runtime)

**When:** An HTTP request through the tunnel fails after initial setup

This is a **runtime warning**, not a startup error:

```
[libp2p] ⚠ tunnel connection lost — request failed: ECONNREFUSED
[libp2p] ⚠ the remote peer may have gone offline
[libp2p] ⚠ retrying will attempt to re-establish the connection
```

The proxy should return a `503 Service Unavailable` to the caller:

```json
{
  "error": {
    "message": "Tunnel to remote shim is unavailable. The remote peer may be offline.",
    "type": "server_error",
    "code": "tunnel_unavailable"
  }
}
```

### Implementation Approach

#### Error Classes (extend `src/utils/ipfs-api.ts`)

Add to the existing error classes from S1-T1:

```typescript
export class PeerIDUnreachableError extends Error {
  constructor(peerID: string, timeoutMs: number) {
    super(
      `PeerID ${peerID} is unreachable (timed out after ${timeoutMs / 1000}s)\n\n` +
      `Possible causes:\n` +
      `  • The remote shim is not running with --libp2p\n` +
      `  • The remote IPFS daemon is offline\n` +
      `  • NAT traversal failed (both peers behind symmetric NAT)\n\n` +
      `Troubleshooting:\n` +
      `  1. Verify the PeerID is correct\n` +
      `  2. Test IPFS connectivity: ipfs swarm connect /p2p/${peerID}\n` +
      `  3. Check tunnel on remote: ipfs p2p ls`
    );
    this.name = 'PeerIDUnreachableError';
  }
}

export class IpfsApiUrlError extends Error {
  constructor(apiUrl: string, cause?: string) {
    super(
      `Could not connect to IPFS API at ${apiUrl}\n\n` +
      (cause ? `Cause: ${cause}\n\n` : '') +
      `Check your daemon's API address:\n` +
      `  $ ipfs config Addresses.API\n\n` +
      `Then pass it explicitly:\n` +
      `  $ --ipfs-api-url http://<host>:<port>`
    );
    this.name = 'IpfsApiUrlError';
  }
}
```

#### Fail-Fast Pattern

Both the shim and client bridge should catch these errors at the top level of `main()` and format them cleanly:

```typescript
main().catch((err) => {
  if (err instanceof IpfsDaemonNotRunningError ||
      err instanceof Libp2pStreamMountingDisabledError ||
      err instanceof PeerIDUnreachableError ||
      err instanceof P2PProtocolInUseError ||
      err instanceof IpfsApiUrlError) {
    // Known error — print clean message without stack trace
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  // Unknown error — print with stack trace
  console.error("[main] fatal error:", err);
  process.exit(1);
});
```

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `src/utils/ipfs-api.ts` | MODIFY | Add `PeerIDUnreachableError`, `IpfsApiUrlError` |
| `client-bridge/src/utils/ipfs-api.ts` | MODIFY | Same additions (keep in sync) |
| `src/index.ts` | MODIFY | Catch known errors, format cleanly |
| `client-bridge/src/index.ts` | MODIFY | Catch known errors, format cleanly |
| `client-bridge/src/libp2p-bridge.ts` | MODIFY | Add runtime 503 response for tunnel failures |
| `src/transport/libp2p.ts` | MODIFY | Ensure all errors are typed and actionable |

---

## Testing Plan

### Unit Tests (`tests/libp2p-errors.test.ts`)

**All tests use mocked `fetch()` responses** — no Kubo daemon or binary needed.

1. **IpfsDaemonNotRunningError** — verify message includes `ipfs daemon` command
2. **Libp2pStreamMountingDisabledError** — verify message includes `ipfs config` command
3. **PeerIDUnreachableError** — verify message includes PeerID, timeout, troubleshooting steps
4. **P2PProtocolInUseError** — verify message includes `ipfs p2p close` command
5. **IpfsApiUrlError** — verify message includes the attempted URL
6. **Runtime tunnel failure** — mock fetch to throw ECONNREFUSED, verify 503 response body

### How to Run Tests

```bash
npm test                     # Runs all unit tests (no Kubo required)
npm run build                # Verify TypeScript compiles
```

---

## Success Metrics

- ✅ Every error condition produces a message a non-technical user can act on
- ✅ No raw stack traces for known error conditions
- ✅ Every error message includes at least one corrective command (for end users who have Kubo)
- ✅ Runtime tunnel failures return proper HTTP error responses
- ✅ All error scenarios have unit tests (using mocked fetch, no Kubo needed)
- ✅ No shell-outs to `ipfs` CLI in the code — only user-facing messages reference CLI commands

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 7 of Sprint 2
