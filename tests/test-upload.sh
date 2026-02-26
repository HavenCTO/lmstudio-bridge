#!/bin/bash
set -e

echo "=== Testing Upload Middleware (Filecoin Calibration) ==="

# Kill existing shim
pkill -f "dist/index.js" 2>/dev/null || true
sleep 2

# Start shim with upload middleware
echo "Starting shim with upload middleware..."
nohup node dist/index.js \
  --http \
  --port 18083 \
  --lmstudio-url http://localhost:12345 \
  --upload \
  --synapse-rpc-url "wss://api.calibration.node.glif.io/rpc/v1" \
  --no-logger > /tmp/shim-upload.log 2>&1 &

SHIM_PID=$!
echo "Shim PID: $SHIM_PID"

echo "Waiting for initialization..."
sleep 30

echo "=== Shim Log (first 50 lines) ==="
head -50 /tmp/shim-upload.log

echo ""
echo "=== Checking if shim is ready ==="
if curl -s http://localhost:18083/health > /dev/null 2>&1; then
    echo "Shim is ready!"
    
    echo ""
    echo "=== Sending test request ==="
    curl -s -X POST http://localhost:18083/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"test-model","messages":[{"role":"user","content":"Upload this to Filecoin!"}]}' | head -c 200
    echo ""
    
    echo ""
    echo "=== Waiting for upload... ==="
    sleep 60
    
    echo ""
    echo "=== Upload log ==="
    tail -50 /tmp/shim-upload.log
else
    echo "Shim failed to start"
    tail -20 /tmp/shim-upload.log
fi

# Cleanup
kill $SHIM_PID 2>/dev/null || true
echo ""
echo "=== Test complete ==="
