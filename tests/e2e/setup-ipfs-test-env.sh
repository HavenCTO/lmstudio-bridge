#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# IPFS Test Environment Setup (QA/CI only — requires Kubo)
# ═══════════════════════════════════════════════════════════════
#
# Creates two isolated IPFS repos, enables Libp2pStreamMounting,
# starts both daemons, and starts the LM Studio mock.
#
# Usage:
#   chmod +x tests/e2e/setup-ipfs-test-env.sh
#   ./tests/e2e/setup-ipfs-test-env.sh
#
# Cleanup:
#   ./tests/e2e/setup-ipfs-test-env.sh teardown

set -euo pipefail

REPO1="/tmp/ipfs-test-node1"
REPO2="/tmp/ipfs-test-node2"

API_PORT_1=5001
API_PORT_2=5002
SWARM_PORT_1=4001
SWARM_PORT_2=4002
GATEWAY_PORT_1=8180
GATEWAY_PORT_2=8181

LMSTUDIO_MOCK_PORT=1234

teardown() {
  echo "[setup] tearing down test environment..."
  # Kill daemons
  kill "$(cat /tmp/ipfs-test-node1.pid 2>/dev/null)" 2>/dev/null || true
  kill "$(cat /tmp/ipfs-test-node2.pid 2>/dev/null)" 2>/dev/null || true
  kill "$(cat /tmp/lmstudio-mock.pid 2>/dev/null)" 2>/dev/null || true
  # Clean repos
  rm -rf "$REPO1" "$REPO2"
  rm -f /tmp/ipfs-test-node1.pid /tmp/ipfs-test-node2.pid /tmp/lmstudio-mock.pid
  echo "[setup] ✓ cleaned up"
}

if [ "${1:-}" = "teardown" ]; then
  teardown
  exit 0
fi

echo "═══════════════════════════════════════════════════"
echo "  IPFS Libp2p Test Environment Setup"
echo "═══════════════════════════════════════════════════"

# Clean up any previous run
teardown 2>/dev/null || true

# ── Initialize Node 1 (Shim side) ──
echo "[setup] initializing IPFS node 1 (shim)..."
IPFS_PATH="$REPO1" ipfs init --profile=test >/dev/null 2>&1
IPFS_PATH="$REPO1" ipfs config --json Experimental.Libp2pStreamMounting true
IPFS_PATH="$REPO1" ipfs config Addresses.API "/ip4/127.0.0.1/tcp/$API_PORT_1"
IPFS_PATH="$REPO1" ipfs config --json Addresses.Swarm "[\"/ip4/0.0.0.0/tcp/$SWARM_PORT_1\"]"
IPFS_PATH="$REPO1" ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/$GATEWAY_PORT_1"
echo "[setup] ✓ node 1 initialized"

# ── Initialize Node 2 (Client bridge side) ──
echo "[setup] initializing IPFS node 2 (client)..."
IPFS_PATH="$REPO2" ipfs init --profile=test >/dev/null 2>&1
IPFS_PATH="$REPO2" ipfs config --json Experimental.Libp2pStreamMounting true
IPFS_PATH="$REPO2" ipfs config Addresses.API "/ip4/127.0.0.1/tcp/$API_PORT_2"
IPFS_PATH="$REPO2" ipfs config --json Addresses.Swarm "[\"/ip4/0.0.0.0/tcp/$SWARM_PORT_2\"]"
IPFS_PATH="$REPO2" ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/$GATEWAY_PORT_2"
echo "[setup] ✓ node 2 initialized"

# ── Start Node 1 ──
echo "[setup] starting IPFS node 1..."
IPFS_PATH="$REPO1" ipfs daemon &
echo $! > /tmp/ipfs-test-node1.pid
sleep 3
echo "[setup] ✓ node 1 running (API port $API_PORT_1)"

# ── Start Node 2 ──
echo "[setup] starting IPFS node 2..."
IPFS_PATH="$REPO2" ipfs daemon &
echo $! > /tmp/ipfs-test-node2.pid
sleep 3
echo "[setup] ✓ node 2 running (API port $API_PORT_2)"

# ── Connect nodes to each other ──
echo "[setup] connecting nodes..."
NODE1_ID=$(IPFS_PATH="$REPO1" ipfs id -f '<id>')
NODE2_ID=$(IPFS_PATH="$REPO2" ipfs id -f '<id>')
IPFS_PATH="$REPO2" ipfs swarm connect "/ip4/127.0.0.1/tcp/$SWARM_PORT_1/p2p/$NODE1_ID" || true
sleep 2
echo "[setup] ✓ nodes connected"

# ── Start LM Studio mock ──
echo "[setup] starting LM Studio mock on port $LMSTUDIO_MOCK_PORT..."
LMSTUDIO_MOCK_PORT=$LMSTUDIO_MOCK_PORT npx ts-node tests/e2e/lmstudio-mock.ts &
echo $! > /tmp/lmstudio-mock.pid
sleep 2
echo "[setup] ✓ LM Studio mock running"

# ── Print summary ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Test Environment Ready"
echo "═══════════════════════════════════════════════════"
echo "  Node 1 (shim):    PeerID=$NODE1_ID  API=127.0.0.1:$API_PORT_1"
echo "  Node 2 (client):  PeerID=$NODE2_ID  API=127.0.0.1:$API_PORT_2"
echo "  LM Studio mock:   127.0.0.1:$LMSTUDIO_MOCK_PORT"
echo ""
echo "  Start shim:"
echo "    node dist/index.js --libp2p --port 18080 --ipfs-api-url http://127.0.0.1:$API_PORT_1"
echo ""
echo "  Start client bridge:"
echo "    cd client-bridge && node dist/index.js --libp2p --peerid $NODE1_ID --port 18081 --ipfs-api-url http://127.0.0.1:$API_PORT_2"
echo ""
echo "  Run tests:"
echo "    npm run test:e2e:libp2p"
echo ""
echo "  Teardown:"
echo "    ./tests/e2e/setup-ipfs-test-env.sh teardown"
echo "═══════════════════════════════════════════════════"
