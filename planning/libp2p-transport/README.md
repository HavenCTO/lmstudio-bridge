# Libp2p Transport — Planning Overview

## Feature Summary

Add a new `--libp2p` transport mode to the LLM Shim + Client Bridge project, enabling users running LM Studio at home behind NAT to access their models from anywhere using a single IPFS PeerID — without configuring routers, running signaling servers, or setting up VPNs.

This leverages Kubo v0.40's p2p tunnel API (`/api/v0/p2p/listen` and `/api/v0/p2p/forward`) which provides automatic NAT traversal via libp2p and persistent PeerID addressing via the Amino DHT.

## User Story

> As a user running LM Studio at home behind NAT, I want to access my models from anywhere using a single PeerID, without configuring routers or running a signaling server.

## ⚠️ Developer Constraints

> **The developer implementing these tasks does NOT have access to:**
> - The `ipfs` CLI binary
> - Kubo (IPFS daemon)
> - Any IPFS-related binaries or tools
>
> **The developer CAN use:**
> - Node.js and npm
> - All files in this repository
> - npm packages (installable via `npm install`)
>
> **What this means for implementation:**
> - All interaction with Kubo must go through its **HTTP RPC API** using `fetch()` — never shell out to the `ipfs` CLI
> - All unit tests must use **mocked HTTP responses** — no running Kubo daemon required for development
> - No `child_process.exec("ipfs ...")` or similar — the code must only make HTTP calls to the Kubo API URL
> - Error messages shown to end users _may_ reference `ipfs` CLI commands (since end users will have Kubo installed), but the code itself must never invoke them
>
> **End users** will have Kubo installed and running. This constraint applies only to the development and testing workflow.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     LIBP2P MODE (NAT-traversing)                        │
│                                                                         │
│  LLM Client ──HTTP──▶ [Client Bridge :8080]                            │
│              POST /v1/chat/completions                                  │
│                           │                                             │
│                   ┌───────▼────────┐                                    │
│                   │ Local TCP port │  (created by `ipfs p2p forward`)   │
│                   └───────┬────────┘                                    │
│                           │                                             │
│                    libp2p stream (NAT-traversing)                       │
│                    protocol: /x/llmshim                                 │
│                           │                                             │
│                   ┌───────▼────────┐                                    │
│                   │ Local TCP port │  (created by `ipfs p2p listen`)    │
│                   └───────┬────────┘                                    │
│                           │                                             │
│                    [Shim :8080] ──HTTP──▶ [LM Studio :1234]            │
│                                                                         │
│  Both sides require a running IPFS daemon (Kubo) with                   │
│  Experimental.Libp2pStreamMounting = true                               │
└──────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decision

The p2p tunnel creates a **local TCP socket** on each side. This means:
- The **shim** runs its existing HTTP transport, bound to localhost
- The **client bridge** forwards to a local TCP port that tunnels through libp2p
- **No changes** to the existing HTTP request handling logic are required
- Traffic flows through the tunnel **transparently**

### Middleware Pipeline Compatibility

The entire middleware pipeline (gzip → encrypt → upload → cid-recorder) continues to process every transaction in libp2p mode. This works because:

1. Middleware is registered on the `Engine` instance (not on the transport)
2. The libp2p transport delegates to `createHttpTransport` internally
3. The HTTP transport calls `engine.handleChatCompletion()` which runs the full middleware chain
4. The client bridge is a simple HTTP proxy — it forwards raw HTTP requests through the tunnel

```
Client App → [Client Bridge HTTP proxy] → libp2p tunnel → [Shim HTTP transport]
    → Engine.handleChatCompletion() → middleware pipeline (gzip/encrypt/upload) → LM Studio
```

No middleware changes are required. Flags like `--gzip`, `--encrypt`, `--upload` work identically with `--libp2p` as they do with `--http`.

## Sprint Breakdown

| Sprint | Focus | Tasks |
|--------|-------|-------|
| **Sprint 1** | IPFS Daemon Client & Shim Listen Mode | 4 tasks — build the IPFS API client utility, add CLI flags, implement listen transport, wire up graceful shutdown |
| **Sprint 2** | Client Bridge Forward Mode & Error Handling | 4 tasks — add client-bridge CLI flags, implement forward transport, graceful shutdown, comprehensive error handling |
| **Sprint 3** | Integration Testing & Documentation | 3 tasks — e2e integration tests, README/architecture updates, manual QA runbook |

## Dependencies

- **End-user runtime:** Kubo (IPFS daemon) v0.40+ installed and running on both server and client machines, with `Experimental.Libp2pStreamMounting` enabled in Kubo config
- **Developer build-time:** Node.js 18+, npm — no IPFS/Kubo binaries required
- No new npm packages required — all interaction is via Kubo's HTTP RPC API using the built-in `fetch()` API

## References

- `kubo/docs/p2p-tunnels.md` — P2P tunnel usage guide (reference documentation for API behaviour)
- `kubo/docs/experimental-features.md` — Libp2pStreamMounting feature docs
- `src/transport/http.ts` — Existing HTTP transport (pattern to follow)
- `src/transport/webrtc.ts` — Existing WebRTC transport (pattern to follow)
- `src/index.ts` — Shim CLI entry point
- `client-bridge/src/index.ts` — Client bridge CLI entry point

## Created

2026-03-14
