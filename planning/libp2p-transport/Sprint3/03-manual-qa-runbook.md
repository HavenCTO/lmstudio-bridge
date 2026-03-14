# S3-T3: Manual QA Runbook

**Owner:** QA / Backend Engineer  
**Estimated Effort:** 1 day  
**Dependencies:** S3-T1 (E2E tests), S3-T2 (documentation)  
**Acceptance Criteria:**
- [ ] QA runbook document created with step-by-step verification scenarios
- [ ] All scenarios executed and results recorded
- [ ] Any bugs found are logged as issues
- [ ] Sign-off that the feature is ready for release

---

## ⚠️ Developer Constraints

> **The developer implementing these tasks does NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> They can only use Node.js, npm, and the files in this repo.
>
> **What this means for this task:**
> - The developer **writes** this QA runbook document but **cannot execute the scenarios** themselves
> - All QA scenarios require a running Kubo daemon — they must be executed by **QA engineers** who have Kubo installed
> - The developer's deliverable is the runbook document itself, verified to compile and render correctly
> - QA engineers execute the runbook and record pass/fail results

---

## QA Runbook

### Environment Requirements

> **Note:** These requirements are for the **QA engineer** executing the runbook, not the developer writing it.

- **Machine A** (or terminal session A): macOS/Linux with Node.js 18+, Kubo v0.40+, LM Studio
- **Machine B** (or terminal session B): macOS/Linux with Node.js 18+, Kubo v0.40+
- Both machines can reach each other over the network (or use two Kubo instances locally)

### Pre-Flight Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | Node.js version | `node --version` | v18.x or higher |
| 2 | Kubo installed | `ipfs version` | 0.40.x or higher |
| 3 | Kubo feature enabled | `ipfs config Experimental.Libp2pStreamMounting` | `true` |
| 4 | IPFS daemon running | `ipfs id` | Returns PeerID JSON |
| 5 | LM Studio running (Machine A) | `curl http://localhost:1234/v1/models` | Returns model list |
| 6 | Project built | `npm run build` | No errors |
| 7 | Client bridge built | `cd client-bridge && npm run build` | No errors |

---

### Scenario 1: Happy Path — Non-Streaming Request

**Steps:**

1. **Machine A:** Start the shim
   ```bash
   node dist/index.js --libp2p --port 8080
   ```
2. **Verify:** PeerID is logged prominently
3. **Verify:** `ipfs p2p ls` shows `/x/llmshim` listener
4. **Machine B:** Start the client bridge
   ```bash
   cd client-bridge
   node dist/index.js --libp2p --peerid <PEER_ID> --port 8080
   ```
5. **Verify:** Client bridge reports "ready"
6. **Machine B:** Send a chat completion request
   ```bash
   curl http://127.0.0.1:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "your-model", "messages": [{"role": "user", "content": "Say hello"}]}'
   ```
7. **Verify:** Valid JSON response with chat completion

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 2: Streaming Request

**Steps:**

1. Same setup as Scenario 1
2. **Machine B:** Send a streaming request
   ```bash
   curl -N http://127.0.0.1:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "your-model", "messages": [{"role": "user", "content": "Write a haiku"}], "stream": true}'
   ```
3. **Verify:** Response has `Content-Type: text/event-stream`
4. **Verify:** Data arrives in SSE chunks (`data: {...}\n\n`)
5. **Verify:** Stream ends with `data: [DONE]\n\n`

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 3: Models Endpoint

**Steps:**

1. Same setup as Scenario 1
2. **Machine B:** Request model list
   ```bash
   curl http://127.0.0.1:8080/v1/models
   ```
3. **Verify:** Response matches LM Studio's model list

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 4: Health Endpoints

**Steps:**

1. Same setup as Scenario 1
2. **Machine A:** Check shim health
   ```bash
   curl http://127.0.0.1:8080/health
   ```
3. **Verify:** `{"status": "ok", "lmstudio": "reachable", ...}`
4. **Machine B:** Check client bridge health
   ```bash
   curl http://127.0.0.1:8080/health
   ```
5. **Verify:** `{"status": "ok", "transport": "libp2p", ...}`

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 5: Custom Protocol Name

**Steps:**

1. **Machine A:**
   ```bash
   node dist/index.js --libp2p --port 8080 --libp2p-protocol /x/mymodel
   ```
2. **Machine B:**
   ```bash
   cd client-bridge
   node dist/index.js --libp2p --peerid <PEER_ID> --port 8080 --libp2p-protocol /x/mymodel
   ```
3. **Verify:** Connection succeeds, requests work
4. **Verify:** `ipfs p2p ls` shows `/x/mymodel` (not `/x/llmshim`)

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 6: Custom IPFS API URL

**Steps:**

1. Start IPFS daemon on non-default port:
   ```bash
   ipfs config --json Addresses.API '"/ip4/127.0.0.1/tcp/5555"'
   ipfs daemon
   ```
2. **Machine A:**
   ```bash
   node dist/index.js --libp2p --port 8080 --ipfs-api-url http://127.0.0.1:5555
   ```
3. **Verify:** Shim starts successfully

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 7: Graceful Shutdown — Shim

**Steps:**

1. Start shim with `--libp2p`
2. Verify `ipfs p2p ls` shows the listener
3. Press Ctrl+C (or `kill -SIGTERM <pid>`)
4. **Verify:** Log shows "tunnel closed"
5. **Verify:** `ipfs p2p ls` shows no tunnels
6. **Verify:** Process exited with code 0

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 8: Graceful Shutdown — Client Bridge

**Steps:**

1. Start client bridge with `--libp2p`
2. Verify `ipfs p2p ls` shows the forwarder
3. Press Ctrl+C
4. **Verify:** Log shows "tunnel closed"
5. **Verify:** `ipfs p2p ls` shows no tunnels

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 9: Error — IPFS Daemon Not Running

**Steps:**

1. Stop IPFS daemon: `ipfs shutdown`
2. Start shim: `node dist/index.js --libp2p`
3. **Verify:** Clean error message (no stack trace)
4. **Verify:** Message mentions `ipfs daemon`
5. **Verify:** Exit code 1

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 10: Error — Libp2pStreamMounting Disabled

**Steps:**

1. Disable feature: `ipfs config --json Experimental.Libp2pStreamMounting false`
2. Restart daemon
3. Start shim: `node dist/index.js --libp2p`
4. **Verify:** Clean error message
5. **Verify:** Message contains enable command
6. Re-enable: `ipfs config --json Experimental.Libp2pStreamMounting true`

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 11: Error — Invalid PeerID

**Steps:**

1. Start client bridge with fake PeerID:
   ```bash
   cd client-bridge
   node dist/index.js --libp2p --peerid QmFakeInvalidPeerID123
   ```
2. **Verify:** Times out with clear error message
3. **Verify:** Message includes troubleshooting steps

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 12: Error — Protocol Already In Use

**Steps:**

1. Start shim with `--libp2p` (default protocol)
2. In another terminal, start a second shim with `--libp2p` (same protocol, different port)
3. **Verify:** Second shim fails with "protocol already in use" error
4. **Verify:** First shim continues running

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 13: Error — Invalid Protocol Name

**Steps:**

1. Start shim: `node dist/index.js --libp2p --libp2p-protocol badname`
2. **Verify:** Validation error about `/x/` prefix
3. **Verify:** Exit code 1

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 14: Existing Modes Unaffected

**Steps:**

1. Start shim in HTTP mode: `node dist/index.js --http --port 8080`
2. **Verify:** Works exactly as before
3. Send test request, verify response
4. Stop shim
5. Start shim in WebRTC mode: `node dist/index.js --webrtc --port 8081`
6. **Verify:** Works exactly as before

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

### Scenario 15: Middleware Pipeline Compatibility

The middleware pipeline (gzip → encrypt → upload → cid-recorder) is registered on the Engine instance and processes every transaction via `engine.handleChatCompletion()`. Since the libp2p transport delegates to `createHttpTransport` internally, the full middleware chain must run identically to HTTP mode.

**Steps:**

1. Start shim with libp2p + gzip middleware:
   ```bash
   node dist/index.js --libp2p --port 8080 --gzip
   ```
2. Connect client bridge:
   ```bash
   cd client-bridge
   node dist/index.js --libp2p --peerid <PEER_ID> --port 8080
   ```
3. Send non-streaming request:
   ```bash
   curl http://127.0.0.1:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "your-model", "messages": [{"role": "user", "content": "Hello"}]}'
   ```
4. **Verify:** Valid JSON response received
5. **Verify:** Shim logs show gzip middleware processing the transaction
6. Send streaming request:
   ```bash
   curl -N http://127.0.0.1:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "your-model", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
   ```
7. **Verify:** SSE stream received correctly with gzip middleware active
8. (Optional) If encrypt/upload middleware is available, repeat with `--gzip --encrypt --upload` to verify full pipeline

**Result:** ☐ Pass ☐ Fail  
**Notes:**

---

## Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| Developer | | | ☐ Approved |
| QA | | | ☐ Approved |
| PM | | | ☐ Approved |

### Files Created

| File | Action | Notes |
|------|--------|-------|
| `planning/libp2p-transport/Sprint3/03-manual-qa-runbook.md` | CREATE | This document |

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 6 of Sprint 3
