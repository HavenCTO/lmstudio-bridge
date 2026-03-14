# S3-T2: Documentation Updates — README, Architecture, CLI Reference

**Owner:** Backend Engineer  
**Estimated Effort:** 2 days  
**Dependencies:** S2-T4 (all implementation complete), S3-T1 (tests passing)  
**Acceptance Criteria:**
- [ ] `README.md` updated with libp2p mode architecture diagram
- [ ] `README.md` updated with libp2p Quick Start section
- [ ] `README.md` CLI reference updated with new flags for both shim and client bridge
- [ ] `docs/architecture.md` updated or new `docs/libp2p-transport.md` created
- [ ] Prerequisites section updated to mention Kubo requirement (for end users)
- [ ] Project structure section updated to show new files
- [ ] All code examples tested and verified working

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> - This task is pure documentation (Markdown) — no IPFS interaction needed
> - Documentation should clearly distinguish between **end-user prerequisites** (Kubo required) and **developer prerequisites** (Node.js + npm only)
> - Code examples in the README are written for **end users** who have Kubo installed
> - The developer can verify Markdown renders correctly and CLI flag names match the implementation

---

## Technical Specification

### README.md Updates

#### 1. Architecture Diagram — Add Libp2p Mode

Add a third diagram to the existing architecture section:

```markdown
┌──────────────────────────────────────────────────────────────────────────┐
│                     LIBP2P MODE (NAT-traversing)                        │
│                                                                         │
│  LLM Client ──HTTP──▶ [Client Bridge :8080]                            │
│              POST /v1/chat/completions                                  │
│                           │                                             │
│                   ┌───────▼────────┐                                    │
│                   │ Local TCP port │  (ipfs p2p forward)                │
│                   └───────┬────────┘                                    │
│                           │                                             │
│                    libp2p stream (NAT-traversing, encrypted)            │
│                    protocol: /x/llmshim                                 │
│                           │                                             │
│                   ┌───────▼────────┐                                    │
│                   │ Local TCP port │  (ipfs p2p listen)                 │
│                   └───────┬────────┘                                    │
│                           │                                             │
│                    [Shim :8080] ──HTTP──▶ [LM Studio :1234]            │
│                                                                         │
│  Requires: Kubo (IPFS) daemon on both machines (end-user setup)         │
│  Config: Experimental.Libp2pStreamMounting = true                       │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 2. Quick Start — Libp2p Mode Section

Add after the existing WebRTC Quick Start:

```markdown
### Libp2p Mode (NAT-Traversing)

**End-User Prerequisites:**
- Kubo (IPFS) v0.40+ installed on both machines
- `Experimental.Libp2pStreamMounting` enabled:
  ```bash
  ipfs config --json Experimental.Libp2pStreamMounting true
  ```

**Machine A – Start the Shim (at home, behind NAT):**
```bash
# Start IPFS daemon
ipfs daemon &

# Start shim with libp2p transport
cd /path/to/shim
npm install && npm run build
node dist/index.js --libp2p --port 8080

# Note the PeerID printed on startup — share with clients
```

**Machine B – Start the Client Bridge (anywhere):**
```bash
# Start IPFS daemon
ipfs daemon &

# Start client bridge with libp2p transport
cd /path/to/shim/client-bridge
npm install && npm run build
node dist/index.js --libp2p --peerid <PEER_ID_FROM_A> --port 8080
```

**Machine B – Send requests:**
```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "Hello via libp2p!"}]
  }'
```
```

#### 3. CLI Reference Updates

**LLM Shim — add to Transport & Core Options:**

```markdown
Libp2p Transport Options:
  --libp2p                      Use libp2p transport (IPFS p2p tunnel)
  --libp2p-protocol <name>      Protocol name for the tunnel (default: /x/llmshim)
  --ipfs-api-url <url>          Kubo IPFS daemon API URL (default: http://127.0.0.1:5001)
```

**LLM Client Bridge — add new options:**

```markdown
Libp2p Transport Options:
  --libp2p                      Use libp2p transport (IPFS p2p tunnel)
  --peerid <id>                 PeerID of the remote shim (required with --libp2p)
  --libp2p-protocol <name>      Protocol name for the tunnel (default: /x/llmshim)
  --ipfs-api-url <url>          Kubo IPFS daemon API URL (default: http://127.0.0.1:5001)
```

#### 4. Prerequisites — Add Kubo (for end users)

```markdown
### Prerequisites

- Node.js 18+
- LM Studio running at `http://localhost:1234` (default)
- **For libp2p mode (end users):** Kubo (IPFS) v0.40+ ([install guide](https://docs.ipfs.tech/install/))

### Developer Prerequisites

- Node.js 18+ and npm
- No IPFS/Kubo binary required for development or unit testing
```

#### 5. Project Structure — Add new files

```markdown
├── src/
│   ├── transport/
│   │   ├── http.ts
│   │   ├── webrtc.ts
│   │   └── libp2p.ts          # NEW: Libp2p listen transport
│   └── utils/
│       └── ipfs-api.ts        # NEW: Kubo HTTP RPC API client
│
├── client-bridge/
│   ├── src/
│   │   ├── libp2p-bridge.ts   # NEW: Libp2p forward + HTTP proxy
│   │   └── utils/
│   │       └── ipfs-api.ts    # NEW: Kubo HTTP RPC API client (copy)
```

### New Architecture Doc (Optional)

If the changes are too large for the README, create `docs/libp2p-transport.md` with:

- How it works (tunnel mechanics)
- Security model (libp2p encryption, localhost binding)
- NAT traversal explanation (DCUtR, relay)
- Troubleshooting guide
- Comparison with WebRTC mode
- Developer vs end-user requirements distinction

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `README.md` | MODIFY | Add diagram, quick start, CLI reference, prerequisites |
| `docs/libp2p-transport.md` | CREATE (optional) | Detailed architecture and troubleshooting |

---

## Testing Plan

### Verification (no Kubo required)

1. All code examples in the README should be copy-pasteable and work (for end users with Kubo)
2. CLI flag names match actual implementation — verify with `node dist/index.js --help`
3. Default values match actual defaults
4. Architecture diagram accurately reflects the data flow
5. Developer prerequisites are clearly separated from end-user prerequisites

---

## Success Metrics

- ✅ A new end user can set up libp2p mode using only the README
- ✅ A new developer understands they don't need Kubo for development
- ✅ All code examples are verified working (for end users)
- ✅ CLI reference matches `--help` output exactly
- ✅ Architecture diagram is accurate

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 5 of Sprint 3
