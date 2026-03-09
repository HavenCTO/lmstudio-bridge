# Decryption Workflow Specification

**Version:** 2.0 (IPLD-Native)  
**Status:** Draft  
**Applies to:** LLM Shim payloads encrypted with `--encrypt --upload`

---

## Overview

The LLM Shim encrypts combined request+response payloads using AES-256-GCM, then uploads the encrypted blobs to IPFS/Filecoin. The AES key is wrapped via Lit Protocol's BLS-IBE threshold encryption, and the resulting encryption metadata is also uploaded to IPFS as a separate file.

This specification covers both the legacy monolithic JSON format and the new IPLD-native DAG format. The IPLD format provides granular addressing, deduplication, and efficient partial retrieval.

The shim supports two key management modes:

- **Session-scoped key** (default): A fresh AES-256 key is generated each time the shim starts. Each session has its own key and metadata CID.
- **Shared key** (`--key-metadata <path>`): A single AES-256 key is persisted locally and reused across all sessions. On first run the key is generated and wrapped via Lit, then the metadata JSON is written to the given path. On subsequent runs the key is recovered by decrypting it from the Lit network. All sessions share the same metadata CID.

This document specifies how to retrieve and decrypt any payload given:
1. The **CID log** (Parquet files produced by the shim)
2. A **wallet** that satisfies the Lit access-control conditions
3. Access to the **Lit Protocol network** used during encryption
4. An **IPFS/Filecoin gateway** to fetch content by CID

---

## 1. CID Log Layout

The shim writes to a directory (default `./cids/`) containing:

### `sessions.parquet`

| Column | Type | Description |
|---|---|---|
| `id` | INT32 | Auto-incrementing session identifier (0, 1, 2, …) |
| `metadataCid` | UTF8 | IPFS CID of the session encryption metadata JSON. Empty string if the session was unencrypted. |

### `<id>.parquet`

One file per session (e.g., `0.parquet`, `1.parquet`). Each contains:

| Column | Type | Description |
|---|---|---|
| `cid` | UTF8 | IPFS CID of an encrypted (or unencrypted) payload blob |
| `rootCid` | UTF8 | IPLD root CID (if using IPLD format) |
| `requestCid` | UTF8 | CID of the request node |
| `responseCid` | UTF8 | CID of the response node |
| `messageCids` | UTF8 | JSON array of message CIDs |
| `timestamp` | INT64 | Unix timestamp (milliseconds) |
| `linkedFrom` | UTF8 | Previous conversation CID (for chain traversal) |

Row order matches upload chronological order.

### Determining if a session is encrypted

Read the `metadataCid` column from `sessions.parquet`:
- **Non-empty string** → session is encrypted. Fetch the metadata CID to begin decryption.
- **Empty string** → session is unencrypted. Payloads are either raw JSON or gzipped JSON (see §6).

---

## 2. Encryption Metadata JSON Schema

Fetch the `metadataCid` from IPFS. The content is a JSON file conforming to:

```json
{
  "version": "hybrid-v1",
  "encryptedKey": "<base64-encoded Lit BLS-IBE ciphertext>",
  "keyHash": "<hex SHA-256 of the raw 32-byte AES key>",
  "algorithm": "AES-GCM",
  "keyLength": 256,
  "ivLengthBytes": 12,
  "accessControlConditions": [
    {
      "contractAddress": "",
      "standardContractType": "",
      "chain": "ethereum",
      "method": "",
      "parameters": [":userAddress"],
      "returnValueTest": {
        "comparator": "=",
        "value": "<wallet-address-lowercase>"
      }
    }
  ],
  "chain": "ethereum"
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `version` | string | Always `"hybrid-v1"`. Future versions may change the layout. |
| `encryptedKey` | string | The AES-256 key encrypted by Lit Protocol BLS-IBE, base64-encoded. This is the `ciphertext` output from `LitNodeClient.encrypt()`. |
| `keyHash` | string | SHA-256 hex digest of the raw 32-byte AES key. This is the `dataToEncryptHash` output from `LitNodeClient.encrypt()`. Used by Lit during decryption to verify integrity. |
| `algorithm` | string | Always `"AES-GCM"`. |
| `keyLength` | number | Always `256` (bits). |
| `ivLengthBytes` | number | Always `12`. The first 12 bytes of every encrypted blob are the IV/nonce. |
| `accessControlConditions` | array | Lit Protocol unified access-control conditions. Defines who can decrypt. The default shim configuration creates an owner-only condition matching a single wallet address. |
| `chain` | string | The EVM chain used for evaluating access-control conditions (e.g., `"ethereum"`, `"polygon"`). |

---

## 3. Encrypted Blob Binary Format

Each encrypted payload blob (fetched by its CID) is a contiguous byte buffer with the following layout:

```
┌──────────┬────────────────────────────┬──────────────┐
│  IV      │  Ciphertext               │  Auth Tag    │
│ 12 bytes │  variable length           │  16 bytes    │
└──────────┴────────────────────────────┴──────────────┘
```

| Offset | Length | Field |
|---|---|---|
| `0` | `12` bytes | **IV (nonce)** — unique per payload, randomly generated |
| `12` | `total - 28` bytes | **Ciphertext** — AES-256-GCM encrypted data |
| `total - 16` | `16` bytes | **Authentication tag** — GCM integrity tag |

Where `total` is the byte length of the entire blob.

The IV is unique for every payload but the AES key is shared across all payloads that use the same encryption metadata. In session-scoped mode this means all payloads in one session; in shared key mode this means all payloads across every session. AES-256-GCM with a 96-bit random nonce is safe for up to 2³² encryptions per key.

---

## 4. Decryption Steps

### Step 1: Resolve the session

1. Read `sessions.parquet` to find the row for the desired session.
2. Extract `metadataCid`. If empty, skip to §6 (unencrypted payloads).

### Step 2: Fetch and parse encryption metadata

1. **Retrieve the file at `metadataCid`** from IPFS/Filecoin.
2. **Verify the retrieved content hash matches the expected CID** using SHA-256:
   ```typescript
   const computedCid = await generateCID(retrievedContent);
   if (computedCid !== expectedMetadataCid) {
     throw new Error("Metadata CID verification failed");
   }
   ```
3. Parse the JSON. Verify `version === "hybrid-v1"`.
4. Extract:
   - `encryptedKey` (base64 string)
   - `keyHash` (hex string)
   - `accessControlConditions` (array)
   - `chain` (string)

**Error Handling for Verification Failures:**
- If verification fails, do NOT proceed with decryption
- Log the CID mismatch details
- Try alternative gateways (the content may be corrupted on one gateway)
- If all gateways fail verification, the data may have been tampered with

### Step 3: Recover the AES key via Lit Protocol

1. Connect to the same Lit network that was used during encryption. The shim defaults to `datil-dev` but this may vary. The network is **not** recorded in the metadata — it must be known out-of-band or configured.
2. Authenticate with a wallet that satisfies the `accessControlConditions`. For the default owner-only condition, this means the wallet address in the `returnValueTest.value` field.
3. Call the Lit SDK's `decrypt()` method:

   **Inputs:**
   - `ciphertext`: the `encryptedKey` field (base64 string)
   - `dataToEncryptHash`: the `keyHash` field (hex string)
   - `unifiedAccessControlConditions`: the `accessControlConditions` array, each entry extended with `"conditionType": "evmBasic"`
   - `chain`: the `chain` field
   - `authSig` or `sessionSigs`: obtained by signing with the authorized wallet

   **Output:**
   - `decryptedData`: a `Uint8Array` of exactly **32 bytes** — this is the raw AES-256 key.

4. **Verify** the recovered key by computing `SHA-256(decryptedData)` and comparing to `keyHash`. If they don't match, the key recovery failed.

### Step 4: Decrypt each payload

For each CID in the session's `<id>.parquet`:

1. **Fetch the blob from IPFS/Filecoin** with CID verification at each hop:
   ```typescript
   const { data, verification } = await fetchAndVerify(cid, gateway);
   if (!verification.valid) {
     throw new Error(`CID verification failed for ${cid}`);
   }
   ```
2. **Verify the CID** of retrieved content before processing
3. Split the blob according to the binary format (§3):
   - `iv = blob[0..12]` (first 12 bytes)
   - `authTag = blob[blob.length - 16 .. blob.length]` (last 16 bytes)
   - `ciphertext = blob[12 .. blob.length - 16]` (everything in between)
4. Decrypt using AES-256-GCM:
   - **Key:** the 32-byte AES key from Step 3
   - **IV/Nonce:** the 12-byte IV extracted above
   - **Ciphertext:** the middle portion
   - **Auth Tag:** the 16-byte tag extracted above
   - **AAD (Additional Authenticated Data):** none (empty)
5. The decrypted plaintext is either:
   - **Gzipped JSON** (if `--gzip` was enabled) → decompress with zlib/gzip
   - **Raw JSON** (if only `--encrypt` was enabled, without `--gzip`)

### Step 5: Parse the plaintext

After decryption (and optional decompression), the plaintext is a JSON object:

```json
{
  "request": { /* OpenAI-compatible chat completion request */ },
  "response": { /* OpenAI-compatible chat completion response */ }
}
```

The `request` follows the OpenAI `ChatCompletionRequest` schema and may include multi-part content with inline base64 images (`image_url` content parts). The `response` follows the OpenAI `ChatCompletionResponse` schema.

---

## 5. Determining Compression

The metadata JSON does **not** explicitly indicate whether the plaintext is gzipped. To determine this:

1. **Check the first two bytes** of the decrypted plaintext:
   - `0x1F 0x8B` → gzip magic number → decompress first
   - `0x7B` (`{`) → raw JSON → parse directly
2. Alternatively, if you know the shim was invoked with `--gzip`, always decompress.

---

## 6. Unencrypted Payloads

If `metadataCid` is empty in `sessions.parquet`, the payloads are **not encrypted**. Fetch each CID directly and the content is either:

- **Gzipped JSON** → check for `0x1F 0x8B` magic bytes, decompress
- **Raw JSON** → parse the `{ request, response }` object directly

**Always verify the CID** of retrieved content even for unencrypted payloads.

---

## 7. IPLD-Native Retrieval (New in v2.0)

For payloads stored using the IPLD-native format (post-refactoring), the retrieval process supports granular access to conversation components.

### 7.1 Resolving IPNS Names

The shim publishes the latest session and conversation CIDs to IPNS for mutable pointers:

```typescript
// Resolve the current session CID from IPNS
const sessionCid = await ipnsManager.resolve(shimId);

// Resolve the conversation index
const indexCid = await ipnsManager.resolve(`${shimId}/conversation-index`);
```

IPNS names follow the pattern:
- `{shim-id}` → Latest session CID
- `{shim-id}/encryption-metadata` → Encryption metadata CID
- `{shim-id}/conversation-index` → Searchable conversation index

### 7.2 Traversing IPLD DAGs

To retrieve individual components without downloading the entire conversation:

```typescript
// Traverse the DAG to get a specific message
const path = "request/messages/0";
const steps = await traverseVerified(rootCid, path, gateways);

// Each step includes verification results
for (const step of steps) {
  console.log(`Path: ${step.path}, CID: ${step.cid}, Valid: ${step.verified}`);
  if (step.error) {
    console.error(`Error: ${step.error}`);
  }
}
```

### 7.3 Verifying Blocks During Traversal

When traversing a DAG, verify each block's CID before following links:

```typescript
async function* traverseVerifiedDAG(rootCid: string, path: string) {
  let currentCid = rootCid;
  const pathParts = path.split('/');
  
  for (const part of pathParts) {
    // 1. Fetch and verify the current node
    const { data, verification } = await fetchAndVerify(currentCid, gateway);
    if (!verification.valid) {
      throw new Error(`CID mismatch at ${currentCid}`);
    }
    
    // 2. Parse and extract the next link
    const node = JSON.parse(new TextDecoder().decode(data));
    const nextLink = node[part];
    
    // 3. If it's a CID link, continue traversal
    if (nextLink && nextLink['/']) {
      currentCid = nextLink['/'];
      yield { cid: currentCid, path: part, verified: true };
    } else {
      // Leaf value
      yield { value: nextLink, path: part, verified: true };
      return;
    }
  }
}
```

### 7.4 Accessing Individual Messages by CID

System prompts and common messages are deduplicated across conversations. Retrieve them by CID:

```typescript
// Get a system prompt that might be shared across many conversations
const promptCid = await promptCache.get(systemPromptContent);
const promptData = await fetchAndVerify(promptCid, gateway);

// The CID verification ensures content integrity
```

### 7.5 IPLD Schema for Conversations

```ipldsch
type Conversation struct {
  version String (default "1.0.0")
  request Request
  response Response
  metadata Metadata
  timestamp Int
  previousConversation optional Link<Conversation>
}

type Request struct {
  model String
  messages [Message]
  parameters optional RequestParameters
}

type Message struct {
  role String
  content union {
    String text
    [ContentPart] parts
  } representation keyed
}
```

---

## 8. Gateway Fallback with Verification

When fetching content, try multiple gateways with verification at each hop:

| Priority | Gateway | Timeout |
|---|---|---|
| 1 | https://ipfs.io/ipfs | 30s |
| 2 | https://dweb.link/ipfs | 30s |
| 3 | https://cloudflare-ipfs.com/ipfs | 30s |
| 4 | https://gateway.pinata.cloud/ipfs | 30s |

**Verification Rules:**
1. Each fetch must pass CID verification before accepting
2. If verification fails on one gateway, try the next
3. If all gateways fail verification, the content is corrupted or tampered
4. Never accept unverified content, even if the gateway returns HTTP 200

---

## 9. Security Considerations

| Concern | Detail |
|---|---|
| **Key scope** | Default: one AES-256 key per shim session. With `--key-metadata`: one key shared across all sessions. All payloads sharing a key use unique IVs. |
| **IV uniqueness** | Each payload gets a cryptographically random 96-bit IV. With a single key, AES-GCM is safe for up to 2³² encryptions. |
| **Access control** | Controlled by Lit Protocol unified access-control conditions. The default is owner-only (single wallet address). Custom conditions can be configured at the shim level. |
| **Key recovery** | Requires the authorized wallet to sign a message for the Lit network. The raw AES key never leaves the shim process in plaintext — it is only transmitted to Lit Protocol in encrypted form. |
| **Forward secrecy** | Not provided. If the AES key is compromised, all payloads encrypted with that key can be decrypted. In session-scoped mode each restart generates a fresh key. In shared key mode all sessions use the same key, so compromise affects the entire history. |
| **Metadata exposure** | The encryption metadata JSON (access-control conditions, encrypted key) is stored on IPFS and is publicly readable. However, the encrypted key can only be unwrapped by wallets satisfying the ACCs via Lit Protocol. |
| **Content verification** | All CIDs are verified during retrieval to detect tampering or corruption. This is essential for decentralized storage where multiple gateways may return different data. |

---

## 10. Reference: Byte Sizes

| Component | Size |
|---|---|
| AES key | 32 bytes (256 bits) |
| IV / Nonce | 12 bytes (96 bits) |
| GCM Auth Tag | 16 bytes (128 bits) |
| Per-blob overhead | 28 bytes (IV + auth tag) |
| Lit ciphertext | Variable (~300-500 bytes base64, depends on network) |
| CID (base32) | ~60 bytes |
| IPLD Link | ~65 bytes (as JSON `{"/": "cid"}`) |

---

## 11. Compatibility Notes

- **Lit Protocol SDK:** The shim uses `@lit-protocol/lit-node-client`. Decryptors should use the same major version. The `encrypt`/`decrypt` API surface is stable across `datil-dev`, `datil-test`, and `datil` networks.
- **AES-256-GCM:** Available in every major language/runtime: Node.js `crypto`, Python `cryptography`, Go `crypto/aes`, Rust `aes-gcm`, Java `javax.crypto`, browser `SubtleCrypto`.
- **Parquet:** Readable with DuckDB, pandas, Apache Arrow, parquet-tools, or any Parquet library.
- **IPFS/Filecoin retrieval:** Any IPFS gateway or Filecoin retrieval client. CIDs are content-addressed and verifiable.
- **IPLD/DAG-JSON:** Use `@ipld/dag-json` for canonical encoding/decoding.
- **Multiformats:** Use `multiformats` library for CID parsing and generation.
