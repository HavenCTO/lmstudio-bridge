# Decryption Workflow Specification

**Version:** 1.0  
**Status:** Draft  
**Applies to:** LLM Shim payloads encrypted with `--encrypt --upload`

---

## Overview

The LLM Shim encrypts combined request+response payloads using AES-256-GCM, then uploads the encrypted blobs to IPFS/Filecoin. The AES key is wrapped via Lit Protocol's BLS-IBE threshold encryption, and the resulting encryption metadata is also uploaded to IPFS as a separate file.

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

1. Retrieve the file at `metadataCid` from IPFS/Filecoin.
2. Parse the JSON. Verify `version === "hybrid-v1"`.
3. Extract:
   - `encryptedKey` (base64 string)
   - `keyHash` (hex string)
   - `accessControlConditions` (array)
   - `chain` (string)

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

1. Fetch the blob from IPFS/Filecoin.
2. Split the blob according to the binary format (§3):
   - `iv = blob[0..12]` (first 12 bytes)
   - `authTag = blob[blob.length - 16 .. blob.length]` (last 16 bytes)
   - `ciphertext = blob[12 .. blob.length - 16]` (everything in between)
3. Decrypt using AES-256-GCM:
   - **Key:** the 32-byte AES key from Step 3
   - **IV/Nonce:** the 12-byte IV extracted above
   - **Ciphertext:** the middle portion
   - **Auth Tag:** the 16-byte tag extracted above
   - **AAD (Additional Authenticated Data):** none (empty)
4. The decrypted plaintext is either:
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

---

## 7. Security Considerations

| Concern | Detail |
|---|---|
| **Key scope** | Default: one AES-256 key per shim session. With `--key-metadata`: one key shared across all sessions. All payloads sharing a key use unique IVs. |
| **IV uniqueness** | Each payload gets a cryptographically random 96-bit IV. With a single key, AES-GCM is safe for up to 2³² encryptions. |
| **Access control** | Controlled by Lit Protocol unified access-control conditions. The default is owner-only (single wallet address). Custom conditions can be configured at the shim level. |
| **Key recovery** | Requires the authorized wallet to sign a message for the Lit network. The raw AES key never leaves the shim process in plaintext — it is only transmitted to Lit Protocol in encrypted form. |
| **Forward secrecy** | Not provided. If the AES key is compromised, all payloads encrypted with that key can be decrypted. In session-scoped mode each restart generates a fresh key. In shared key mode all sessions use the same key, so compromise affects the entire history. |
| **Metadata exposure** | The encryption metadata JSON (access-control conditions, encrypted key) is stored on IPFS and is publicly readable. However, the encrypted key can only be unwrapped by wallets satisfying the ACCs via Lit Protocol. |

---

## 8. Reference: Byte Sizes

| Component | Size |
|---|---|
| AES key | 32 bytes (256 bits) |
| IV / Nonce | 12 bytes (96 bits) |
| GCM Auth Tag | 16 bytes (128 bits) |
| Per-blob overhead | 28 bytes (IV + auth tag) |
| Lit ciphertext | Variable (~300-500 bytes base64, depends on network) |

---

## 9. Compatibility Notes

- **Lit Protocol SDK:** The shim uses `@lit-protocol/lit-node-client`. Decryptors should use the same major version. The `encrypt`/`decrypt` API surface is stable across `datil-dev`, `datil-test`, and `datil` networks.
- **AES-256-GCM:** Available in every major language/runtime: Node.js `crypto`, Python `cryptography`, Go `crypto/aes`, Rust `aes-gcm`, Java `javax.crypto`, browser `SubtleCrypto`.
- **Parquet:** Readable with DuckDB, pandas, Apache Arrow, parquet-tools, or any Parquet library.
- **IPFS/Filecoin retrieval:** Any IPFS gateway or Filecoin retrieval client. CIDs are content-addressed and verifiable.