# LM Studio Bridge Data Recovery

Data recovery tools for restoring LM Studio Bridge testing data stored on IPFS/Synapse with TACo encryption.

## Overview

This module provides scripts and utilities to:

1. **Retrieve** CAR files from IPFS gateways or Synapse/Filecoin network
2. **Extract** IPLD conversation data from CAR files
3. **Decrypt** TACo-encrypted payloads (when credentials available)
4. **Save** recovered data in readable formats

## Quick Start

### Installation

```bash
cd data-recovery
npm install
npm run build
```

### Basic Usage

```bash
# Recover a single conversation by CID
npm run recover -- bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi

# Extract from a local CAR file
npm run extract -- ./path/to/file.car

# List available CIDs from metadata directory
npm run list -- --metadata-dir ./data/metadata

# Batch recover all CIDs from a file
npm run recover-all -- --cid-file ./cids.txt --output ./recovered
```

## CLI Reference

### `recover <CID>`

Recover a single conversation from IPFS by CID.

```bash
lmbridge-recover recover <CID> [options]

Options:
  -g, --gateway <url>           IPFS gateway URL (default: https://ipfs.io)
  -o, --output <dir>            Output directory (default: ./recovered)
  --skip-decryption             Skip decryption even if data is encrypted
  --taco-domain <domain>        TACo domain (e.g., lynx, ursula)
  --taco-ritual-id <id>         TACo ritual ID (default: 27)
  --taco-private-key <key>      TACo private key for authentication
  --rpc-url <url>               Blockchain RPC URL
  --save-car                    Save raw CAR files to output directory
  --verbose                     Enable verbose logging
```

### `recover-all`

Batch recover multiple conversations from metadata directory or CID list.

```bash
lmbridge-recover recover-all [options]

Options:
  -m, --metadata-dir <dir>      Directory containing metadata JSON files
  -c, --cid-file <file>         File containing list of CIDs (one per line)
  -g, --gateway <url>           IPFS gateway URL (default: https://ipfs.io)
  -o, --output <dir>            Output directory (default: ./recovered)
  --skip-decryption             Skip decryption even if data is encrypted
  --taco-domain <domain>        TACo domain
  --taco-ritual-id <id>         TACo ritual ID (default: 27)
  --taco-private-key <key>      TACo private key
  --rpc-url <url>               Blockchain RPC URL
  --save-car                    Save raw CAR files
  --verbose                     Enable verbose logging
```

### `list`

List available CIDs from a metadata directory.

```bash
lmbridge-recover list [options]

Options:
  -m, --metadata-dir <dir>      Directory containing metadata JSON files (default: ./data)
  --json                        Output in JSON format
```

### `decrypt <CID>`

Decrypt an encrypted conversation (requires TACo credentials).

```bash
lmbridge-recover decrypt <CID> [options]

Options:
  -g, --gateway <url>           IPFS gateway URL (default: https://ipfs.io)
  -o, --output <dir>            Output directory (default: ./decrypted)
  --taco-domain <domain>        TACo domain (default: lynx)
  --taco-ritual-id <id>         TACo ritual ID (default: 27)
  --taco-private-key <key>      TACo private key (required)
  --rpc-url <url>               Blockchain RPC URL
```

### `extract <CAR-file>`

Extract conversation from a local CAR file.

```bash
lmbridge-recover extract <CAR-file> [options]

Options:
  -o, --output <path>           Output file path
  --format <format>             Output format: json, pretty-json, ndjson (default: pretty-json)
```

## Programmatic API

### TypeScript Example

```typescript
import { 
  recoverConversation,
  parseCarFile,
  extractConversation,
  retrieveFromGateway 
} from './data-recovery';

// Simple recovery
const result = await recoverConversation(
  { type: 'cid', cid: 'bafy...abc' },
  { 
    outputDir: './recovered',
    ipfsGateway: 'https://ipfs.io'
  }
);

if (result.success && result.conversation) {
  console.log('Recovered model:', result.conversation.request.model);
  console.log('Messages:', result.conversation.request.messages.length);
}
```

### Batch Recovery

```typescript
import { recoverConversations } from './data-recovery';

const cids = ['cid1', 'cid2', 'cid3'];

const results = await recoverConversations(
  cids.map(cid => ({ type: 'cid' as const, cid })),
  { 
    outputDir: './recovered',
    saveCarFiles: true 
  }
);

console.log(`Success: ${results.filter(r => r.success).length}/${results.length}`);
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Step 1: Retrieval                                         │
│  CID → IPFS Gateway / Synapse → CAR bytes                  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Step 2: CAR Parsing                                        │
│  CAR bytes → IPLD blocks → DAG reconstruction              │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Step 3: Conversation Extraction                            │
│  IPLD DAG → Request/Response/Metadata objects              │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Step 4: Decryption (if needed)                             │
│  Encrypted buffer + TACo key → Plaintext                   │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Step 5: Output                                             │
│  JSON files in output directory                            │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

```bash
# TACo Configuration
export TACO_DOMAIN="lynx"
export TACO_RITUAL_ID="27"
export TACO_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
export TEST_PRIVATE_KEY="0x..."  # For decryption

# IPFS Gateway
export IPFS_GATEWAY="https://ipfs.io"
```

### Metadata Files

The recovery tool looks for metadata files created during the upload process. These should be in JSON format with fields like:

```json
{
  "uploadCid": "bafy...",
  "rootCid": "bafy...",
  "requestCid": "bafy...",
  "responseCid": "bafy...",
  "uploadSize": 1234,
  "uploadTimestamp": "2025-01-15T10:30:00.000Z",
  "encryptedKey": "...",
  "keyHash": "...",
  "accessControlConditions": [...],
  "chain": "ethereum"
}
```

## Important Notes

### Encrypted Data Recovery

If your testing data was encrypted with TACo:

1. You need access to the wallet private key that was used for encryption
2. The ritual must still be active on the TACo network
3. The encrypted payload buffer needs to be available (stored separately from IPLD data)

Without these, you can only recover the IPLD conversation metadata, not the actual request/response content.

### Recommended Workflow

For next week's team to restore this week's testing data:

1. **Locate metadata**: Find the metadata JSON files from the upload process
2. **Gather credentials**: Ensure TACo private key is available
3. **Run batch recovery**: Use `recover-all` with the metadata directory
4. **Verify output**: Check recovered JSON files for completeness

## Troubleshooting

### "Failed to retrieve CID from IPFS"

- Try a different gateway with `--gateway https://cloudflare-ipfs.com`
- Verify the CID is correct and the data was actually uploaded

### "TACo decryption failed"

- Verify the ritual is still active
- Check that the private key corresponds to a wallet that satisfies the access conditions
- Ensure the TACo domain matches the network used during encryption

### "Encrypted payload not available"

The encrypted buffer is stored separately from the IPLD conversation. Check:
- Upload logs for the encrypted buffer location
- Metadata files for references to encrypted data
- Temporary files from the upload process
