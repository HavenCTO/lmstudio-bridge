# S3-T1: End-to-End Integration Tests

**Owner:** Backend Engineer  
**Estimated Effort:** 3 days  
**Dependencies:** S2-T4 (all implementation and error handling complete)  
**Acceptance Criteria:**
- [ ] E2E test: shim listen → client bridge forward → chat completion request succeeds
- [ ] E2E test: streaming (SSE) request works through the tunnel
- [ ] E2E test: `/v1/models` endpoint proxied correctly
- [ ] E2E test: `/health` endpoints report correct status on both sides
- [ ] E2E test: graceful shutdown cleans up tunnels on both sides
- [ ] E2E test: error scenarios (daemon down, feature disabled) produce correct errors
- [ ] Tests can run with two local Kubo instances (different IPFS_PATH and ports)
- [ ] Test runner script provided for easy local execution
- [ ] All tests documented in a test plan

---

## ⚠️ Developer Constraints

> **You do NOT have access to the `ipfs` CLI, Kubo, or any IPFS binaries.**
> You can only use Node.js, npm, and the files in this repo.
>
> **What this means for E2E tests:**
> - The developer **writes** the E2E test code and test runner scripts, but **cannot run them locally**
> - E2E tests require a Kubo daemon, which the developer does not have — these tests will be run by **QA engineers or CI environments** that have Kubo installed
> - The developer should ensure unit tests (mocked) cover the same logic paths so they can validate correctness without Kubo
> - Test setup scripts may reference `ipfs` CLI commands since they are executed by QA/CI (not the developer)
> - The developer can verify the test code **compiles** (`npm run build`) and that non-Kubo-dependent parts work

---

## Technical Specification

### Test Environment Setup

Running E2E tests requires two IPFS daemon instances on the same machine (simulating server and client). Use separate `IPFS_PATH` directories and port configurations.

**Note:** This setup script is for QA engineers / CI environments that have Kubo installed. The developer writes it but cannot run it locally.

```bash
# Instance 1 (server side)
export IPFS_PATH_SERVER=/tmp/ipfs-test-server
ipfs init --repo-dir $IPFS_PATH_SERVER
ipfs --repo-dir $IPFS_PATH_SERVER config --json Experimental.Libp2pStreamMounting true
ipfs --repo-dir $IPFS_PATH_SERVER config --json Addresses.API '"/ip4/127.0.0.1/tcp/5011"'
ipfs --repo-dir $IPFS_PATH_SERVER config --json Addresses.Gateway '"/ip4/127.0.0.1/tcp/8011"'
ipfs --repo-dir $IPFS_PATH_SERVER config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4011", "/ip4/0.0.0.0/udp/4011/quic-v1"]'
ipfs --repo-dir $IPFS_PATH_SERVER daemon &

# Instance 2 (client side)
export IPFS_PATH_CLIENT=/tmp/ipfs-test-client
ipfs init --repo-dir $IPFS_PATH_CLIENT
ipfs --repo-dir $IPFS_PATH_CLIENT config --json Experimental.Libp2pStreamMounting true
ipfs --repo-dir $IPFS_PATH_CLIENT config --json Addresses.API '"/ip4/127.0.0.1/tcp/5012"'
ipfs --repo-dir $IPFS_PATH_CLIENT config --json Addresses.Gateway '"/ip4/127.0.0.1/tcp/8012"'
ipfs --repo-dir $IPFS_PATH_CLIENT config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4012", "/ip4/0.0.0.0/udp/4012/quic-v1"]'
ipfs --repo-dir $IPFS_PATH_CLIENT daemon &

# Connect the two peers
SERVER_ID=$(ipfs --repo-dir $IPFS_PATH_SERVER id -f "<id>")
ipfs --repo-dir $IPFS_PATH_CLIENT swarm connect /ip4/127.0.0.1/tcp/4011/p2p/$SERVER_ID
```

### Test File

```
tests/e2e/libp2p-transport.test.ts
```

### Test Setup/Teardown Script

```
tests/e2e/setup-ipfs-test-env.sh
```

This script (executed by QA/CI, not developer):
1. Initializes two temporary IPFS repos
2. Configures ports to avoid conflicts
3. Enables Libp2pStreamMounting on both
4. Starts both daemons
5. Connects the peers
6. Exports environment variables for the test runner
7. On teardown: kills both daemons, removes temp repos

### Test Cases

#### TC1: Basic Chat Completion Through Tunnel

```
Given: Shim running with --libp2p on server IPFS instance
  And: Client bridge running with --libp2p --peerid <SERVER_ID> on client IPFS instance
  And: LM Studio mock running on localhost:1234
When:  POST /v1/chat/completions to client bridge
Then:  Response is a valid OpenAI chat completion
  And: Response came through the tunnel (verify via shim logs)
```

#### TC2: Streaming Chat Completion Through Tunnel

```
Given: Same setup as TC1
When:  POST /v1/chat/completions with "stream": true
Then:  Response is SSE stream with correct Content-Type header
  And: Chunks arrive incrementally
  And: Final [DONE] marker received
```

#### TC3: Models List Through Tunnel

```
Given: Same setup as TC1
When:  GET /v1/models on client bridge
Then:  Response matches LM Studio's model list
```

#### TC4: Health Endpoints

```
Given: Same setup as TC1
When:  GET /health on shim
Then:  Response shows status "ok", lmstudio "reachable"

When:  GET /health on client bridge
Then:  Response shows status "ok", transport "libp2p"
```

#### TC5: Graceful Shutdown — Shim

```
Given: Same setup as TC1
When:  Send SIGTERM to shim process
Then:  ipfs p2p ls on server instance shows no tunnels
  And: Shim process exits with code 0
```

#### TC6: Graceful Shutdown — Client Bridge

```
Given: Same setup as TC1
When:  Send SIGTERM to client bridge process
Then:  ipfs p2p ls on client instance shows no tunnels
  And: Client bridge process exits with code 0
```

#### TC7: Error — Daemon Not Running

```
Given: No IPFS daemon running (or wrong --ipfs-api-url)
When:  Start shim with --libp2p
Then:  Exit code 1
  And: Error message contains "ipfs daemon"
  And: No stack trace
```

#### TC8: Error — Feature Disabled

```
Given: IPFS daemon running but Libp2pStreamMounting = false
When:  Start shim with --libp2p
Then:  Exit code 1
  And: Error message contains "Libp2pStreamMounting"
```

#### TC9: Error — PeerID Unreachable

```
Given: Client IPFS daemon running, feature enabled
When:  Start client bridge with --libp2p --peerid QmFakePeerID123
Then:  Exit code 1 (after timeout)
  And: Error message contains "unreachable"
```

### LM Studio Mock

For tests, use a lightweight Express server that mimics LM Studio's API:

```typescript
// tests/e2e/lmstudio-mock.ts
// Returns canned chat completion responses
// Supports both streaming and non-streaming
// No external dependencies beyond express (already in project)
```

### Test Runner

```bash
# tests/e2e/run-libp2p-tests.sh
# NOTE: This script requires Kubo (ipfs CLI). It is intended for QA/CI environments.
# The developer cannot run this locally.
#!/bin/bash
set -e

echo "Setting up test IPFS environment..."
source ./tests/e2e/setup-ipfs-test-env.sh

echo "Building project..."
npm run build
cd client-bridge && npm run build && cd ..

echo "Running E2E tests..."
npx jest tests/e2e/libp2p-transport.test.ts --testTimeout=60000

echo "Cleaning up..."
cleanup_ipfs_test_env
```

### Files Created

| File | Action | Notes |
|------|--------|-------|
| `tests/e2e/libp2p-transport.test.ts` | CREATE | E2E test suite |
| `tests/e2e/lmstudio-mock.ts` | CREATE | Lightweight LM Studio mock |
| `tests/e2e/setup-ipfs-test-env.sh` | CREATE | IPFS test environment setup/teardown (for QA/CI) |
| `tests/e2e/run-libp2p-tests.sh` | CREATE | One-command test runner (for QA/CI) |

---

## Testing Notes

- E2E tests **require Kubo** — they are written by the developer but **run by QA or CI**
- The developer verifies correctness via:
  - Unit tests (mocked, no Kubo) — `npm test`
  - Build verification — `npm run build`
  - Code review of test logic
- Tests need ~60s timeout due to IPFS daemon startup and tunnel establishment
- Tests should be tagged/labeled so they're excluded from `npm test` (fast unit tests only)
- Add to `package.json`:
  ```json
  "test:e2e:libp2p": "bash tests/e2e/run-libp2p-tests.sh"
  ```

---

## Success Metrics

- ✅ All 9 test cases are written and compile (`npm run build`)
- ✅ Test setup/teardown scripts are complete and documented
- ✅ Tests pass when run by QA/CI with Kubo installed
- ✅ Tests complete in under 2 minutes
- ✅ Tests are isolated (don't affect the user's real IPFS repo)
- ✅ Test runner script is executable and documented
- ✅ Developer can verify test code compiles without Kubo

---

**Status:** PENDING  
**Created:** 2026-03-14  
**Target Completion:** Day 3 of Sprint 3
