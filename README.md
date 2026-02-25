# LLM Shim + Client Bridge

A lightweight Node.js/TypeScript system that accepts OpenAI-compatible LLM requests and proxies them to [LM Studio](https://lmstudio.ai). Supports **HTTP** (direct) and **WebRTC** (via client bridge) transport modes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HTTP MODE (simple)                              │
│                                                                        │
│  LLM Client ──HTTP──▶ [Shim :8080] ──HTTP──▶ [LM Studio :1234]       │
│              POST /v1/chat/completions                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       WebRTC MODE (tunneled)                           │
│                                                                        │
│  LLM Client ──HTTP──▶ [Client Bridge :8080]                           │
│              POST /v1/chat/completions                                 │
│                           │                                            │
│                      WebRTC DataChannel                                │
│                      (protocol v1, handshake,                          │
│                       llm_request/llm_response)                        │
│                           │                                            │
│                    [Shim :8081] ──HTTP──▶ [LM Studio :1234]           │
│                    POST /pair (control)                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### WebRTC Pairing Flow

1. **Client Bridge** creates a PeerConnection + DataChannel(`"llm"`, ordered, maxRetransmits=3)
2. **Client Bridge** waits for ICE gathering to complete (bundled ICE, no trickle)
3. **Client Bridge** starts an ephemeral HTTP signaling server with `GET /offer` and `POST /answer` (bearer token auth, 60s timeout, single-use answer)
4. **Client Bridge** sends pairing info `{ip, port, token}` to the **Shim** via `POST /pair`
5. **Shim** fetches the SDP offer from the Client Bridge (`GET /offer`)
6. **Shim** creates a PeerConnection, sets remote description, creates answer
7. **Shim** submits the SDP answer (`POST /answer`)
8. **Client Bridge** shuts down the signaling server
9. WebRTC DataChannel opens
10. Both sides exchange handshake messages (protocol version negotiation)
11. LLM requests flow as `llm_request` / `llm_response` / `llm_error` messages

### DataChannel Protocol Messages

All messages are UTF-8 JSON, max 16 KB, with `schema_version: 1`:

| Type | Direction | Purpose |
|------|-----------|---------|
| `handshake` | bidirectional | Protocol version negotiation |
| `llm_request` | client bridge → shim | OpenAI chat completion request |
| `llm_response` | shim → client bridge | OpenAI chat completion response |
| `llm_error` | shim → client bridge | Error response |

### Middleware Pipeline

The shim has a modular middleware layer. Each middleware can intercept/modify:
- **Request phase**: Before sending to LM Studio (OpenAI format + LM Studio format available)
- **Response phase**: After receiving from LM Studio (both formats available)

Built-in middleware:
- **`logger`** – logs request/response metrics (enabled by default, disable with `--no-logger`)
- **`gzip`** – gzip-compresses the response payload (`--gzip`)
- **`encrypt`** – AES-256-GCM + Lit Protocol BLS-IBE hybrid encryption (`--encrypt`)
- **`upload`** – uploads the (optionally compressed/encrypted) payload to Filecoin via Synapse (`--upload`)

The middleware pipeline is ordered: **gzip → encrypt → upload**. Each step is optional and feeds its output to the next.

## Quick Start

### Prerequisites

- Node.js 18+
- LM Studio running at `http://localhost:1234` (default)

### HTTP Mode (Simple)

```bash
# Install & build the shim
cd /path/to/shim
npm install
npm run build

# Start in HTTP mode (default)
node dist/index.js --http --port 8080

# Test
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### WebRTC Mode (Tunneled)

**Terminal 1 – Start the Shim (WebRTC mode):**
```bash
cd /path/to/shim
npm install && npm run build
node dist/index.js --webrtc --port 8081
```

**Terminal 2 – Start the Client Bridge:**
```bash
cd /path/to/shim/client-bridge
npm install && npm run build
node dist/index.js --shim-url http://127.0.0.1:8081 --port 8080
```

**Terminal 3 – Send requests to the Client Bridge:**
```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "Hello via WebRTC!"}]
  }'
```

## CLI Reference

### LLM Shim (`llm-shim`)

```
Transport & Core Options:
  --http                        Use HTTP transport (default)
  --webrtc                      Use WebRTC transport
  --port <number>               Port for the transport server (default: 8080)
  --host <address>              Bind address (default: 0.0.0.0)
  --lmstudio-url <url>          LM Studio base URL (default: http://localhost:1234)
  --lmstudio-token <tok>        LM Studio API token
  --timeout <ms>                Request timeout to LM Studio (default: 120000)
  --no-logger                   Disable built-in logger middleware

Gzip Middleware:
  --gzip                        Enable gzip compression of responses
  --gzip-level <0-9>            Compression level (default: 6)

Encrypt Middleware (Lit Protocol):
  --encrypt                     Enable Lit Protocol hybrid encryption
  --lit-network <network>       Lit network: datil-dev | datil-test | datil (default: datil-dev)
  --wallet-address <0x...>      Wallet address for owner-only access control (required with --encrypt)
  --lit-chain <chain>           EVM chain for ACCs (default: ethereum)

Upload Middleware (Synapse / Filecoin):
  --upload                      Enable Synapse upload to Filecoin
  --synapse-private-key <0x..>  Private key for Filecoin transactions
                                (or set HAVEN_PRIVATE_KEY env var)
  --synapse-rpc-url <url>       Filecoin RPC WebSocket URL
                                (default: wss://api.calibration.node.glif.io/rpc/v1)
  --no-upload-metadata          Skip uploading encryption metadata as separate file
```

#### Middleware Pipeline Examples

```bash
# Compress responses only
llm-shim --gzip --gzip-level 9

# Encrypt responses with Lit Protocol (testnet)
llm-shim --encrypt --wallet-address 0xYourWallet

# Full pipeline: compress → encrypt → upload to Filecoin
llm-shim --gzip --encrypt --wallet-address 0xYourWallet \
  --upload --synapse-private-key 0xYourKey

# Upload only (no compression or encryption)
llm-shim --upload --synapse-private-key 0xYourKey
```

#### Optional Peer Dependencies

The encrypt and upload middleware use optional SDKs that are dynamically imported at runtime:

| Middleware | Optional Dependency | Install |
|-----------|-------------------|---------|
| `--encrypt` | `@lit-protocol/lit-node-client` | `npm install @lit-protocol/lit-node-client` |
| `--upload` | `filecoin-pin` | `npm install filecoin-pin` |

These are **not** required at build time. If not installed, the middleware will fail at runtime with a clear error.

**HTTP mode endpoints:**
- `POST /v1/chat/completions` – OpenAI-compatible chat completions
- `GET /v1/models` – Model list
- `GET /health` – Health check

**WebRTC mode endpoints:**
- `POST /pair` – Initiate pairing with a client bridge (`{ip, port, token}`)
- `GET /status` – Connection and handshake status
- `GET /health` – Health check

### LLM Client Bridge (`llm-client-bridge`)

```
Options:
  --shim-url <url>           URL of the shim's control server (required)
  --port <number>            Port for local OpenAI-compatible API (default: 8080)
  --host <address>           Bind address for local API (default: 127.0.0.1)
  --signaling-port <number>  Port for ephemeral signaling server (default: 0 = random)
  --timeout <ms>             Request timeout for LLM requests (default: 120000)
```

**Local endpoints (after connection):**
- `POST /v1/chat/completions` – OpenAI-compatible chat completions (proxied over WebRTC)
- `GET /v1/models` – Model list
- `GET /health` – Health check

## Writing Custom Middleware

```typescript
import { Middleware, RequestPayload, ResponsePayload, NextFunction } from "./types";

export const myMiddleware: Middleware = {
  name: "my-middleware",

  onRequest: async (payload: RequestPayload, next: NextFunction) => {
    // Modify payload.openaiRequest or payload.lmstudioRequest
    console.log(`Request for model: ${payload.openaiRequest.model}`);
    await next();
  },

  onResponse: async (payload: ResponsePayload, next: NextFunction) => {
    // Modify payload.openaiResponse or payload.lmstudioResponse
    await next();
  },
};
```

Register in the shim's `src/index.ts`:
```typescript
engine.use(myMiddleware);
```

## Project Structure

```
shim/
├── src/                      # LLM Shim source
│   ├── index.ts              # CLI entry point
│   ├── client/               # LM Studio HTTP client
│   │   └── lmstudio-client.ts
│   ├── middleware/            # Built-in middleware
│   │   ├── logger.ts         #   Request/response logging
│   │   ├── gzip.ts           #   Gzip compression
│   │   ├── encrypt.ts        #   AES-256-GCM + Lit Protocol encryption
│   │   └── upload.ts         #   Synapse/Filecoin upload
│   ├── pipeline/             # Core engine, translator, middleware runner
│   │   ├── engine.ts
│   │   ├── middleware-runner.ts
│   │   └── translator.ts
│   ├── transport/            # HTTP and WebRTC transports
│   │   ├── http.ts
│   │   └── webrtc.ts
│   └── types/                # TypeScript type definitions
│       ├── index.ts
│       ├── lmstudio.ts
│       ├── middleware.ts
│       ├── openai.ts
│       └── protocol.ts       # Shared protocol types
│
├── client-bridge/            # Client-side WebRTC bridge
│   ├── src/
│   │   ├── index.ts          # CLI entry point
│   │   ├── protocol.ts       # Protocol types (synced with shim)
│   │   ├── signaling-server.ts  # Ephemeral HTTP signaling server
│   │   └── webrtc-client.ts  # WebRTC PeerConnection + DataChannel
│   ├── package.json
│   └── tsconfig.json
│
├── package.json
├── tsconfig.json
└── README.md
```

## Protocol Summary

| Protocol Element | Details |
|---|---|
| Signaling | HTTP GET /offer, POST /answer |
| Auth | Bearer token (16-64 alphanumeric chars) |
| ICE | Bundled (no trickle) |
| Timeout | 60 seconds |
| Single-use answer | Yes (409 on duplicate) |
| DataChannel label | `"llm"` |
| DataChannel config | ordered=true, maxRetransmits=3 |
| Message format | UTF-8 JSON, 16 KB max |
| Handshake | schema_version + protocol_version negotiation |
| Version negotiation | min/max overlap → highest mutual version |
