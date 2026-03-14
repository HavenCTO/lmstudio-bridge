# Libp2p Transport — Manual QA Runbook

**Version:** 1.0  
**Target:** Kubo v0.40+ with `Experimental.Libp2pStreamMounting` enabled  
**Prerequisites:** Two machines (or two IPFS repos on one machine), Kubo installed

---

## Environment Setup

### Machine A (Shim / Server Side)
```bash
# 1. Enable experimental feature
ipfs config --json Experimental.Libp2pStreamMounting true

# 2. Start IPFS daemon
ipfs daemon &

# 3. Note your PeerID
ipfs id -f '<id>'

# 4. Start shim with libp2p
node dist/index.js --libp2p --port 8080
```

### Machine B (Client Bridge)
```bash
# 1. Enable experimental feature
ipfs config --json Experimental.Libp2pStreamMounting true

# 2. Start IPFS daemon
ipfs daemon &

# 3. Start client bridge (use PeerID from Machine A)
cd client-bridge
node dist/index.js --libp2p --peerid <PEER_ID_FROM_MACHINE_A> --port 8080
```

---

## Test Scenarios

| # | Scenario | Steps | Expected Result | Pass/Fail | Notes |
|---|----------|-------|-----------------|-----------|-------|
| 1 | **Shim starts with --libp2p** | Run `node dist/index.js --libp2p --port 8080` | Process starts, logs PeerID, no errors | ☐ | |
| 2 | **Client bridge connects** | Run `node dist/index.js --libp2p --peerid <id> --port 8080` | Logs "tunnel established", "bridge is ready" | ☐ | |
| 3 | **Non-streaming chat completion** | `curl -X POST http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"test","messages":[{"role":"user","content":"Hello"}]}'` | 200 OK with JSON response containing assistant message | ☐ | |
| 4 | **Streaming (SSE) chat completion** | Same as #3 but add `"stream": true` to body | 200 OK with `text/event-stream`, multiple `data:` lines, ends with `[DONE]` | ☐ | |
| 5 | **Models endpoint** | `curl http://127.0.0.1:8080/v1/models` | 200 OK with model list | ☐ | |
| 6 | **Health endpoint (shim)** | `curl http://127.0.0.1:8080/health` (on shim port) | `{"status":"ok"}` | ☐ | |
| 7 | **Health endpoint (client bridge)** | `curl http://127.0.0.1:8080/health` (on client bridge port) | `{"status":"ok","transport":"libp2p","peerID":"..."}` | ☐ | |
| 8 | **Missing required fields** | POST to `/v1/chat/completions` without `model` field | 400 error with descriptive message | ☐ | |
| 9 | **Daemon not running** | Stop IPFS daemon, then start shim with `--libp2p` | Clean error: "IPFS daemon not reachable... Start with: ipfs daemon" | ☐ | |
| 10 | **Feature disabled** | Set `Libp2pStreamMounting false`, restart daemon, start shim | Clean error: "Libp2pStreamMounting is not enabled" with fix command | ☐ | |
| 11 | **PeerID unreachable** | Start client bridge with invalid PeerID | Clean error: "PeerID ... is unreachable" with troubleshooting steps | ☐ | |
| 12 | **Protocol already in use** | Start shim twice with same `--libp2p-protocol` | Clean error: "Protocol ... is already in use" with close command | ☐ | |
| 13 | **Graceful shutdown (shim)** | Press Ctrl+C while shim is running | Logs "shutting down", "tunnel closed", exits cleanly | ☐ | |
| 14 | **Graceful shutdown (client)** | Press Ctrl+C while client bridge is running | Logs "shutting down", "tunnel closed", "proxy closed", exits cleanly | ☐ | |
| 15 | **Tunnel cleanup verification** | After shutdown, run `ipfs p2p ls` | No lingering tunnels for `/x/llmshim` | ☐ | |

---

## Middleware Pipeline Tests (with libp2p)

| # | Scenario | Command | Expected | Pass/Fail |
|---|----------|---------|----------|-----------|
| M1 | **Gzip through tunnel** | `node dist/index.js --libp2p --gzip --port 8080` | Chat completions work, gzip middleware logs visible | ☐ |
| M2 | **Encrypt through tunnel** | `node dist/index.js --libp2p --encrypt --wallet-address 0x... --port 8080` | Chat completions work, encrypt middleware logs visible | ☐ |
| M3 | **Full pipeline** | `node dist/index.js --libp2p --gzip --encrypt --upload --wallet-address 0x... --synapse-private-key 0x... --port 8080` | All middleware logs visible, CID recorded | ☐ |

---

## Regression Tests

| # | Scenario | Steps | Expected | Pass/Fail |
|---|----------|-------|----------|-----------|
| R1 | **HTTP mode unaffected** | `node dist/index.js --http --port 8080` | Works exactly as before | ☐ |
| R2 | **WebRTC mode unaffected** | `node dist/index.js --webrtc --port 8080` | Works exactly as before | ☐ |
| R3 | **Mutual exclusivity** | `node dist/index.js --http --libp2p` | Error: "Only one transport mode" | ☐ |

---

## Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| QA Engineer | | | |
| Backend Engineer | | | |
| Product Manager | | | |

---

## Notes
- All error messages should be clean (no stack traces) and include actionable fix commands
- Streaming responses should have no timeout issues for long-running completions
- Tunnel ports are bound to 127.0.0.1 only (security: no external binding)
