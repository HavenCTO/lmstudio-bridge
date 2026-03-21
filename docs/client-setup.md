# WebRTC Client Setup Guide

Connect to LM Studio on another computer over LAN using QR code signaling.

## Setup

```bash
npm install
npm run build
```

## Pairing (both computers at same time)

**Server** (has LM Studio):
```bash
node dist/qr-server.js
```
Copy the compressed SDP string shown.

**Client** (this computer):
```bash
node dist/qr-client.js
```
Paste the server's SDP string → generates answer → paste answer back to server.

## Use the LLM

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"any","messages":[{"role":"user","content":"Hello!"}]}'
```

## Options

```bash
node dist/qr-client.js --port 3000      # different port
node dist/qr-client.js --host 0.0.0.0   # accessible from LAN
```
