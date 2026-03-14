# S2-T2: Implement Client Bridge Libp2p Forward Transport

**Owner:** Backend Engineer  
**Estimated Effort:** 3 days  
**Dependencies:** S2-T1 (client bridge CLI flags), S1-T1 (IPFS API client utility)  
**Acceptance Criteria:**
- [ ] On start: verify IPFS daemon is running via HTTP RPC (fail fast if not)
- [ ] On start: verify `Experimental.Libp2pStreamMounting` is enabled via HTTP RPC (fail fast if not)
- [ ] On start: call `p2pForward` via HTTP RPC to create a tunnel to the remote PeerID
- [ ] On start: wait for the tunnel to be ready (TCP port listening)
- [ ] On start: start a local HTTP proxy that forwards requests through the tunnel
- [ ] The local HTTP proxy exposes the same endpoints as the existing WebRTC client bridge (`/v1/chat/completions`, `/v1/models`, `/health`)
- [ ] Requests to the local proxy are forwarded as standard HTTP through the tunnel to the remote shim
- [ ] Streaming responses (SSE) pass through correctly
- [ ] `npm run build` succeeds in `client-bridge/`

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - All Kubo interaction uses the `ipfs-api.ts` utility which calls `fetch()` against the HTTP RPC API
> - **Never** shell out to `ipfs` CLI — all calls go through `client-bridge/src/utils/ipfs-api.ts`
> - Unit tests use **mocked IPFS API functions and mocked HTTP responses** — no running Kubo daemon needed
> - TCP connectivity checks (waiting for tunnel) use Node.js `net` module — no external binaries
> - Reference `kubo/docs/p2p-tunnels.md` for API behaviour documentation

---

## Technical Specification

### Design

Unlike the WebRTC client bridge (which manages a DataChannel with a custom protocol), the libp2p client bridge is simpler:

1. Call Kubo's p2p forward endpoint via HTTP RPC to create a local TCP socket that tunnels to the remote shim
2. Start a local Express server that proxies HTTP requests to `127.0.0.1:<tunnel-port>`
3. The remote shim runs its standard HTTP transport — it receives normal HTTP requests

This means:
- **No custom protocol messages** (unlike WebRTC's `llm_request` / `llm_response`)
- **Streaming works** — SSE flows through the TCP tunnel natively
- **Standard HTTP proxy** — simply forward requests and pipe responses
- **Middleware pipeline fully preserved** — the remote shim's HTTP transport calls `engine.handleChatCompletion()` which runs the full middleware chain (gzip → encrypt → upload → cid-recorder) on every request. The client bridge proxy is transparent — it just forwards HTTP. Flags like `--gzip`, `--encrypt`, `--upload` on the shim work identically with libp2p as with HTTP mode.

### Target File

```
client-bridge/src/libp2p-bridge.ts
```

### Interface

```typescript
export interface Libp2pBridgeOptions {
  /** Remote shim's PeerID */
  peerID: string;
  /** Libp2p protocol name */
  protocol: string;
  /** Local port for the tunnel endpoint (auto-assigned if 0) */
  tunnelPort: number;
  /** Port for the local OpenAI-compatible HTTP server */
  proxyPort: number;
  /** Host for the local HTTP server */
  proxyHost: string;
  /** Kubo HTTP RPC API URL */
  ipfsApiUrl: string;
  /** Request timeout in ms */
  timeoutMs: number;
}
```

### Startup Sequence

All Kubo interaction uses HTTP `fetch()` via `ipfs-api.ts` — no CLI:

```
1. Verify IPFS daemon running (HTTP RPC: POST /api/v0/id)
   → checkDaemonRunning(ipfsApiUrl)
   → Throw IpfsDaemonNotRunningError if not

2. Verify Libp2pStreamMounting enabled (HTTP RPC: POST /api/v0/config/show)
   → checkLibp2pStreamMounting(ipfsApiUrl)
   → Throw Libp2pStreamMountingDisabledError if not

3. Create p2p forward tunnel (HTTP RPC: POST /api/v0/p2p/forward)
   → p2pForward(protocol, `/ip4/127.0.0.1/tcp/${tunnelPort}`, peerID)
   → This tells Kubo to create a local TCP socket at 127.0.0.1:tunnelPort

4. Wait for tunnel ready
   → Use Node.js `net.createConnection()` to attempt TCP connection to 127.0.0.1:tunnelPort
   → Retry with backoff (up to 10s)
   → If timeout, throw PeerIDUnreachableError

5. Start local HTTP proxy server
   → Express server on proxyHost:proxyPort
   → Proxy all requests to 127.0.0.1:tunnelPort
```

### HTTP Proxy Implementation

The proxy forwards requests to the tunnel's local TCP endpoint. Since the tunnel terminates at the remote shim's HTTP transport, standard HTTP proxying works:

```typescript
// POST /v1/chat/completions → forward to tunnel
app.post("/v1/chat/completions", async (req, res) => {
  const tunnelUrl = `http://127.0.0.1:${tunnelPort}/v1/chat/completions`;
  
  const upstream = await fetch(tunnelUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // For streaming: pipe the response
  if (req.body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Pipe upstream body to client response
    // ... (use ReadableStream piping)
  } else {
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  }
});
```

### Tunnel Port Selection

- Default: use port `0` to let the OS assign a random available port
- The `p2pForward` call specifies the listen address; the developer should parse the actual bound port
- Alternatively, pick a fixed high port (e.g., `9191`) as a sensible default

### Console Output (expected)

```
[libp2p] verifying IPFS daemon at http://127.0.0.1:5001...
[libp2p] ✓ IPFS daemon running
[libp2p] ✓ Libp2pStreamMounting enabled
[libp2p] creating tunnel to PeerID: 12D3KooWExAmPlE...
[libp2p] ✓ tunnel established: /x/llmshim → 127.0.0.1:9191 → /p2p/12D3KooWExAmPlE
[libp2p] waiting for tunnel connectivity...
[libp2p] ✓ tunnel reachable

[main] ✓ local OpenAI-compatible API available at:
[main]   POST http://127.0.0.1:8080/v1/chat/completions
[main]   GET  http://127.0.0.1:8080/v1/models
[main]   GET  http://127.0.0.1:8080/health
[main]
[main] client bridge is ready! (transport: libp2p)
```

### Wiring in `client-bridge/src/index.ts`

Replace the stub from S2-T1:

```typescript
import { createLibp2pBridge } from "./libp2p-bridge";

if (mode === "libp2p") {
  const bridge = createLibp2pBridge({
    peerID: opts.peerid!,
    protocol: opts.libp2pProtocol,
    tunnelPort: 0,  // auto-assign
    proxyPort: parseInt(opts.port, 10),
    proxyHost: opts.host,
    ipfsApiUrl: opts.ipfsApiUrl,
    timeoutMs: parseInt(opts.timeout, 10),
  });
  await bridge.start();
}
```

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `client-bridge/src/libp2p-bridge.ts` | CREATE | Libp2p forward mode + HTTP proxy |
| `client-bridge/src/index.ts` | MODIFY | Wire up libp2p bridge |

---

## Testing Plan

### Unit Tests (`client-bridge/tests/libp2p-bridge.test.ts`)

**All tests use mocked IPFS API functions and mocked HTTP** — no Kubo daemon or binary needed.

Mock IPFS API client functions:

1. **Happy path** — daemon running, feature enabled, forward succeeds, proxy starts
2. **Daemon not running** — throws `IpfsDaemonNotRunningError`
3. **Feature disabled** — throws `Libp2pStreamMountingDisabledError`
4. **PeerID unreachable** — tunnel created but TCP connection times out → throws `PeerIDUnreachableError`
5. **Proxy forwards requests** — mock tunnel endpoint, verify HTTP request is proxied correctly
6. **Streaming passthrough** — verify SSE headers and body piping

### How to Run Tests

```bash
cd client-bridge
npm test                     # Runs all unit tests (no Kubo required)
npm run build                # Verify TypeScript compiles
```

---

## Success Metrics

- ✅ Client bridge starts with `--libp2p --peerid <id>` and creates a tunnel via HTTP RPC
- ✅ Local HTTP proxy forwards requests through the tunnel
- ✅ Non-streaming responses work correctly
- ✅ Streaming (SSE) responses pipe through correctly
- ✅ `/health` endpoint reports tunnel status
- ✅ Fail-fast errors for daemon / feature / connectivity issues
- ✅ No shell-outs to `ipfs` CLI anywhere in the code
- ✅ All unit tests pass with mocked HTTP, no Kubo needed

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 4 of Sprint 2
