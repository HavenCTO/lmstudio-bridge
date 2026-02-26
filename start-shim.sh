#!/bin/bash
exec node dist/index.js \
  --http \
  --port 8887 \
  --host 0.0.0.0 \
  --lmstudio-url http://localhost:1234 \
  --gzip \
  --encrypt \
  --lit-network naga-dev \
  --wallet-address "0x1234567890123456789012345678901234567890" \
  --upload \
  --no-logger > /tmp/shim-full.log 2>&1
