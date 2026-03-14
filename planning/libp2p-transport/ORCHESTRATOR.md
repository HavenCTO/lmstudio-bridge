# Libp2p Transport Orchestrator

**Project:** Libp2p Transport Mode (IPFS P2P Tunnels)  
**Agent ID:** Generated per-session  
**Target:** Kubo v0.40+ with Experimental.Libp2pStreamMounting  
**Timeline:** 3-4 weeks  
**Team:** 1 Backend Engineer + QA + PM

---

## ⚠️ Developer Constraints

> **The developer implementing these tasks does NOT have access to:**
> - The `ipfs` CLI binary, Kubo (IPFS daemon), or any IPFS-related binaries
>
> **The developer CAN use:**
> - Node.js and npm
> - All files in this repository
> - npm packages (installable via `npm install`)
>
> **Rules:**
> - All Kubo interaction must use HTTP RPC `fetch()` — never shell out to `ipfs` CLI
> - All unit tests must use mocked HTTP responses — no running Kubo daemon required
> - Error messages shown to end users _may_ reference `ipfs` CLI commands (end users will have Kubo)
> - E2E tests and QA scenarios are written by the developer but executed by QA/CI with Kubo installed

---

## Executive Summary (1-Pager for Product/PM)

### What We're Doing
Adding a new `--libp2p` transport mode to both the LLM Shim and Client Bridge, enabling users running LM Studio at home behind NAT to access their models from anywhere using a single IPFS PeerID — without configuring routers, running signaling servers, or setting up VPNs.

### Why This Matters
- **NAT traversal out of the box**: libp2p handles hole-punching, relay, and DCUtR automatically
- **Persistent addressing**: PeerID doesn't change across sessions or IP changes
- **No signaling server**: Unlike WebRTC mode, no separate signaling infrastructure needed
- **End-to-end encrypted**: libp2p streams are encrypted by default (Noise protocol)
- **Zero middleware changes**: The existing pipeline (gzip → encrypt → upload → cid-recorder) works transparently

### Risks & Caveats
- **Requires Kubo on both machines**: End users must install and configure Kubo v0.40+
- **Experimental feature**: `Libp2pStreamMounting` is still experimental in Kubo
- **Symmetric NAT**: Both peers behind symmetric NAT may fail to connect (rare but possible)
- **Latency**: Traffic routes through libp2p relays adds latency vs direct TCP
- **Developer cannot test E2E locally**: No Kubo binary available during development; relies on mocked unit tests

### Timeline Overview
| Sprint | Duration | Focus | Owner |
|--------|----------|-------|-------|
| S1 | Week 1-2 | IPFS API client, shim CLI flags, listen transport, graceful shutdown | BE |
| S2 | Week 2-3 | Client bridge CLI, forward transport, shutdown, error handling | BE |
| S3 | Week 3-4 | E2E integration tests, documentation, QA runbook | BE + QA |

### Go/No-Go Criteria
- ✅ Shim starts with `--libp2p`, registers tunnel, logs PeerID
- ✅ Client bridge starts with `--libp2p --peerid <id>`, creates tunnel, proxies HTTP
- ✅ Non-streaming and streaming (SSE) chat completions work through the tunnel
- ✅ Middleware pipeline (gzip/encrypt/upload) processes every transaction
- ✅ Graceful shutdown cleans up tunnels on both sides
- ✅ Error conditions produce actionable, user-friendly messages (no stack traces)
- ✅ Existing HTTP and WebRTC modes are unaffected
- ✅ All unit tests pass (mocked, no Kubo needed)
- ✅ E2E tests pass (run by QA with Kubo)

---

## Sprint Breakdown

### Sprint 1: IPFS API Client & Shim Listen Mode (Week 1-2)
**Goal:** Build the Kubo HTTP RPC client utility, add CLI flags, implement the listen transport, wire up graceful shutdown

#### Tasks
1. [ ] **S1-T1**: Create IPFS Daemon HTTP API Client Utility ([`Sprint1/01-ipfs-api-client.md`](./Sprint1/01-ipfs-api-client.md))
2. [ ] **S1-T2**: Add Libp2p CLI Flags to the Shim ([`Sprint1/02-shim-cli-flags.md`](./Sprint1/02-shim-cli-flags.md))
3. [ ] **S1-T3**: Implement Shim Libp2p Listen Transport ([`Sprint1/03-shim-listen-transport.md`](./Sprint1/03-shim-listen-transport.md))
4. [ ] **S1-T4**: Shim Libp2p Graceful Shutdown ([`Sprint1/04-shim-graceful-shutdown.md`](./Sprint1/04-shim-graceful-shutdown.md))

**Deliverables at end of Sprint 1:**
- `src/utils/ipfs-api.ts` — Kubo HTTP RPC client (all interaction via `fetch()`)
- `src/transport/libp2p.ts` — Libp2p listen transport (wraps HTTP transport)
- Updated `src/index.ts` with `--libp2p`, `--libp2p-protocol`, `--ipfs-api-url` flags
- Unit tests for all IPFS API functions and transport logic (mocked, no Kubo needed)
- `npm run build` and `npm test` pass

---

### Sprint 2: Client Bridge Forward Mode & Error Handling (Week 2-3)
**Goal:** Add libp2p mode to the client bridge, implement the forward transport, add comprehensive error handling

#### Tasks
1. [ ] **S2-T1**: Add Libp2p CLI Flags to the Client Bridge ([`Sprint2/01-client-bridge-cli-flags.md`](./Sprint2/01-client-bridge-cli-flags.md))
2. [ ] **S2-T2**: Implement Client Bridge Libp2p Forward Transport ([`Sprint2/02-client-bridge-forward-transport.md`](./Sprint2/02-client-bridge-forward-transport.md))
3. [ ] **S2-T3**: Client Bridge Libp2p Graceful Shutdown ([`Sprint2/03-client-bridge-shutdown.md`](./Sprint2/03-client-bridge-shutdown.md))
4. [ ] **S2-T4**: Comprehensive Error Handling for Libp2p Transport ([`Sprint2/04-error-handling.md`](./Sprint2/04-error-handling.md))

**Deliverables at end of Sprint 2:**
- `client-bridge/src/libp2p-bridge.ts` — Forward transport + HTTP proxy
- `client-bridge/src/utils/ipfs-api.ts` — Copy of IPFS API client for client bridge
- Updated `client-bridge/src/index.ts` with `--libp2p`, `--peerid`, etc.
- 6 typed error classes with actionable user-friendly messages
- Unit tests for all client bridge logic (mocked, no Kubo needed)
- `npm run build` and `npm test` pass in both root and `client-bridge/`

---

### Sprint 3: Integration Testing & Documentation (Week 3-4)
**Goal:** Write E2E tests, update all documentation, create QA runbook

#### Tasks
1. [ ] **S3-T1**: End-to-End Integration Tests ([`Sprint3/01-e2e-integration-tests.md`](./Sprint3/01-e2e-integration-tests.md))
2. [ ] **S3-T2**: Documentation Updates — README, Architecture, CLI Reference ([`Sprint3/02-documentation-updates.md`](./Sprint3/02-documentation-updates.md))
3. [ ] **S3-T3**: Manual QA Runbook ([`Sprint3/03-manual-qa-runbook.md`](./Sprint3/03-manual-qa-runbook.md))

**Deliverables at end of Sprint 3:**
- E2E test suite (9 test cases) + LM Studio mock + test runner scripts
- Updated README with architecture diagram, quick start, CLI reference
- QA runbook with 15 scenarios and sign-off table
- All tests passing (unit: by developer; E2E: by QA/CI)

---

## Middleware Pipeline Compatibility

The entire middleware pipeline (gzip → encrypt → upload → cid-recorder) continues to process every transaction in libp2p mode with **zero changes**:

```
Client App → [Client Bridge HTTP proxy] → libp2p tunnel → [Shim HTTP transport]
    → Engine.handleChatCompletion() → middleware pipeline (gzip/encrypt/upload) → LM Studio
```

1. Middleware is registered on the `Engine` instance (not on the transport)
2. The libp2p transport delegates to `createHttpTransport` internally
3. The HTTP transport calls `engine.handleChatCompletion()` which runs the full chain
4. The client bridge is a transparent HTTP proxy — it just forwards requests

Flags like `--gzip`, `--encrypt`, `--upload` work identically with `--libp2p` as with `--http`.

---

## Code Change Map (High-Level)

### Files to Create
| File | Purpose |
|------|---------|
| `src/utils/ipfs-api.ts` | Kubo HTTP RPC client (fetch-based, no CLI) |
| `src/transport/libp2p.ts` | Libp2p listen transport (wraps HTTP transport) |
| `client-bridge/src/libp2p-bridge.ts` | Libp2p forward transport + HTTP proxy |
| `client-bridge/src/utils/ipfs-api.ts` | Copy of IPFS API client for client bridge |
| `tests/utils/ipfs-api.test.ts` | Unit tests for IPFS API client |
| `tests/transport/libp2p.test.ts` | Unit tests for listen transport |
| `tests/libp2p-errors.test.ts` | Unit tests for error handling |
| `client-bridge/tests/libp2p-bridge.test.ts` | Unit tests for client bridge |
| `tests/e2e/libp2p-transport.test.ts` | E2E test suite (run by QA/CI) |
| `tests/e2e/lmstudio-mock.ts` | LM Studio mock for E2E tests |
| `tests/e2e/setup-ipfs-test-env.sh` | IPFS test environment setup (QA/CI) |
| `tests/e2e/run-libp2p-tests.sh` | One-command E2E test runner (QA/CI) |

### Files to Modify
| File | Change Type | Description |
|------|-------------|-------------|
| `src/index.ts` | CLI + transport | Add `--libp2p`, `--libp2p-protocol`, `--ipfs-api-url`; add transport branch; wire shutdown |
| `client-bridge/src/index.ts` | CLI + mode | Add `--libp2p`, `--peerid`, etc.; make `--shim-url` conditionally required; add mode branch |
| `README.md` | Documentation | Add libp2p architecture diagram, quick start, CLI reference, prerequisites |

### Files NOT Modified
| File | Reason |
|------|--------|
| `src/transport/http.ts` | Libp2p wraps this — no changes needed |
| `src/transport/webrtc.ts` | Independent transport — unaffected |
| `src/pipeline/engine.ts` | Middleware registered here — no changes needed |
| `src/middleware/*.ts` | All middleware — untouched, works transparently |

---

## Error Catalog

| Error | When | Exit | User-Facing Fix |
|-------|------|------|-----------------|
| `IpfsDaemonNotRunningError` | `fetch()` to `/api/v0/id` fails | 1 | `ipfs daemon` |
| `Libp2pStreamMountingDisabledError` | Config check returns false | 1 | `ipfs config --json Experimental.Libp2pStreamMounting true` |
| `P2PProtocolInUseError` | p2pListen/p2pForward conflict | 1 | `ipfs p2p close --protocol-id /x/llmshim` |
| `PeerIDUnreachableError` | TCP tunnel timeout | 1 | Verify PeerID, check remote shim |
| `IpfsApiUrlError` | Wrong URL / non-JSON response | 1 | `ipfs config Addresses.API` |
| Tunnel disconnect (runtime) | HTTP request ECONNREFUSED | 503 | Remote peer may be offline |

---

## Critical Configuration Questions (Needs Answer Before Sprint 1)

1. **Default protocol name?** Current plan: `/x/llmshim`. Is this acceptable or should it be more specific (e.g., `/x/haven-llmshim`)?

2. **Tunnel port allocation?** Client bridge uses port 0 (OS auto-assign) for the tunnel TCP socket. Should we allow `--tunnel-port` override?

3. **Timeout for tunnel connectivity check?** Current plan: 10s with backoff. Should this be configurable via `--tunnel-timeout`?

4. **Kubo version requirement?** Plan requires v0.40+ for `Libp2pStreamMounting`. Should we check Kubo version at startup and warn if too old?

5. **Should `ipfs-api.ts` be a shared npm package?** Currently copied between shim and client-bridge. If more packages need it, consider extracting to a shared local package.

---

## Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Developer cannot test E2E (no Kubo binary) | M | Comprehensive mocked unit tests; QA runs E2E |
| Symmetric NAT blocks both peers | L | Document in troubleshooting; recommend relay config |
| Kubo experimental feature breaks in future version | M | Pin minimum Kubo version; monitor Kubo releases |
| Tunnel port conflicts on multi-instance setups | L | Use port 0 (auto-assign); allow `--tunnel-port` |
| Large streaming responses timeout through tunnel | M | Disable HTTP timeouts on proxy (match existing pattern) |
| `ipfs-api.ts` copy diverges between shim and client-bridge | L | Note in docs; consider shared package if divergence occurs |

---

## Command Reference for QA

```bash
# ── Developer commands (no Kubo needed) ──
npm install                     # Install dependencies
npm run build                   # Build TypeScript
npm test                        # Run unit tests (mocked, no Kubo)

cd client-bridge
npm install && npm run build    # Build client bridge
npm test                        # Run client bridge unit tests

# ── End-user / QA commands (Kubo required) ──

# Enable experimental feature
ipfs config --json Experimental.Libp2pStreamMounting true

# Start IPFS daemon
ipfs daemon &

# Start shim with libp2p transport
node dist/index.js --libp2p --port 8080

# Start shim with libp2p + full middleware pipeline
node dist/index.js --libp2p --port 8080 --gzip --encrypt --wallet-address 0x... --upload --synapse-private-key 0x...

# Start client bridge with libp2p transport
cd client-bridge
node dist/index.js --libp2p --peerid 12D3KooW... --port 8080

# Test the connection
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "test", "messages": [{"role": "user", "content": "Hello via libp2p!"}]}'

# Run E2E tests (QA/CI only — requires two Kubo instances)
npm run test:e2e:libp2p
```

---

## Sprint Meeting Cadence

| Meeting | Frequency | Attendees | Agenda |
|---------|-----------|-----------|--------|
| Sprint Kickoff | Start of each sprint | BE + QA + PM | Review tasks, confirm acceptance criteria |
| Daily Standup | Daily (15 min) | BE | Blockers, progress |
| Mid-Sprint Check-in | Mid-week | BE + PM | Demo progress; adjust scope if needed |
| Sprint Retrospective | End of each sprint | BE + QA + PM | What went well, what to improve |
| QA Handoff | End of Sprint 2 | BE → QA | Hand off E2E test runner and QA runbook |
| Go/No-Go Gate | End of Sprint 3 | All | Final decision on merge/release |

---

## Post-Implementation Validation Checklist

After all sprints complete, verify these before declaring success:

- [ ] `node dist/index.js --libp2p` starts, logs PeerID, registers tunnel via HTTP RPC
- [ ] `node dist/index.js --libp2p --peerid <id>` (client bridge) creates forward tunnel, starts proxy
- [ ] Non-streaming chat completion works through tunnel
- [ ] Streaming (SSE) chat completion works through tunnel
- [ ] `/v1/models` proxied correctly
- [ ] `/health` reports correct status on both sides
- [ ] `--gzip` middleware processes transactions through tunnel
- [ ] `--encrypt` + `--upload` middleware processes transactions through tunnel
- [ ] Graceful shutdown (SIGINT/SIGTERM) cleans up tunnels on both sides
- [ ] Error: daemon not running → clean message, no stack trace
- [ ] Error: feature disabled → clean message with enable command
- [ ] Error: PeerID unreachable → timeout with troubleshooting
- [ ] Error: protocol in use → clean message with close command
- [ ] Existing `--http` mode unchanged
- [ ] Existing `--webrtc` mode unchanged
- [ ] All unit tests pass (`npm test`, no Kubo needed)
- [ ] All E2E tests pass (QA/CI with Kubo)
- [ ] README updated with architecture diagram, quick start, CLI reference
- [ ] QA runbook completed and signed off

---

**Document Version:** 1.0  
**Last Updated:** 2026-03-14  
**Status:** Ready for Sprint 1 Execution
