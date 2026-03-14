#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# One-command E2E test runner for libp2p transport (QA/CI only)
# ═══════════════════════════════════════════════════════════════
#
# This script:
#   1. Sets up the IPFS test environment (2 nodes + LM Studio mock)
#   2. Starts the shim with --libp2p
#   3. Starts the client bridge with --libp2p --peerid
#   4. Runs the E2E Jest test suite
#   5. Tears everything down
#
# Usage:
#   chmod +x tests/e2e/run-libp2p-tests.sh
#   ./tests/e2e/run-libp2p-tests.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SHIM_PORT=18080
CLIENT_PORT=18081
API_PORT_1=5001
API_PORT_2=5002

cleanup() {
  echo ""
  echo "[runner] cleaning up..."
  kill "$(cat /tmp/shim-libp2p.pid 2>/dev/null)" 2>/dev/null || true
  kill "$(cat /tmp/client-bridge-libp2p.pid 2>/dev/null)" 2>/dev/null || true
  rm -f /tmp/shim-libp2p.pid /tmp/client-bridge-libp2p.pid
  "$SCRIPT_DIR/setup-ipfs-test-env.sh" teardown 2>/dev/null || true
  echo "[runner] ✓ cleanup complete"
}

trap cleanup EXIT

echo "═══════════════════════════════════════════════════"
echo "  Libp2p Transport E2E Test Runner"
echo "═══════════════════════════════════════════════════"

# Step 1: Build
echo "[runner] building project..."
cd "$PROJECT_ROOT"
npm run build
cd "$PROJECT_ROOT/client-bridge"
npm run build
cd "$PROJECT_ROOT"

# Step 2: Setup IPFS test environment
echo "[runner] setting up IPFS test environment..."
"$SCRIPT_DIR/setup-ipfs-test-env.sh"

# Get PeerID of node 1 (shim side)
NODE1_ID=$(curl -s -X POST "http://127.0.0.1:$API_PORT_1/api/v0/id" | jq -r '.ID')
echo "[runner] shim PeerID: $NODE1_ID"

# Step 3: Start shim with libp2p
echo "[runner] starting shim with --libp2p on port $SHIM_PORT..."
node "$PROJECT_ROOT/dist/index.js" \
  --libp2p \
  --port $SHIM_PORT \
  --ipfs-api-url "http://127.0.0.1:$API_PORT_1" \
  --lmstudio-url "http://127.0.0.1:1234" &
echo $! > /tmp/shim-libp2p.pid
sleep 3

# Step 4: Start client bridge with libp2p
echo "[runner] starting client bridge with --libp2p on port $CLIENT_PORT..."
node "$PROJECT_ROOT/client-bridge/dist/index.js" \
  --libp2p \
  --peerid "$NODE1_ID" \
  --port $CLIENT_PORT \
  --ipfs-api-url "http://127.0.0.1:$API_PORT_2" &
echo $! > /tmp/client-bridge-libp2p.pid
sleep 5

# Step 5: Run E2E tests
echo "[runner] running E2E tests..."
cd "$PROJECT_ROOT"
npx jest tests/e2e/libp2p-transport.test.ts --no-cache --verbose

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ All E2E tests complete"
echo "═══════════════════════════════════════════════════"
