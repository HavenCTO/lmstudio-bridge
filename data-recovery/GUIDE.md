# Data Recovery Guide for LM Studio Bridge Testing Data

## Overview

This guide walks you through recovering testing data that was stored this week using the LM Studio Bridge. The data is stored on IPFS via Synapse in IPLD format and may be encrypted using TACo (Threshold Access Control).

## Prerequisites

1. **Node.js 18+** installed
2. **Access to metadata files** from the upload process (typically in `./data/metadata`)
3. **TACo private key** if data was encrypted (ask your teammate who ran the uploads)
4. **Network access** to IPFS gateways and blockchain RPC endpoints

## Step-by-Step Recovery

### Step 1: Set Up the Recovery Environment

```bash
cd /home/user/lmstudio-bridge/data-recovery

# Install dependencies
npm install

# Build the project
npm run build

# Copy environment template and configure
cp .env.example .env.local
# Edit .env.local with your TACo credentials
```

### Step 2: Locate Your Metadata Files

The upload process creates JSON metadata files. Look for them in:

```
./data/metadata/
```

Each file should contain information like:
- `uploadCid` - The root CID of the conversation
- `encryptedKey` - If TACo encryption was used
- `accessControlConditions` - The TACo access policy

List available CIDs:

```bash
npm run list -- --metadata-dir ./data/metadata
```

### Step 3: Recover Non-Encrypted Data

If your testing data was NOT encrypted:

```bash
npm run recover-all -- \
  --metadata-dir ./data/metadata \
  --output ./recovered \
  --gateway https://ipfs.io
```

Or using the quick script:

```bash
chmod +x quick-recover.sh
./quick-recover.sh -m ./data/metadata -o ./recovered
```

### Step 4: Recover Encrypted Data (if applicable)

If your data WAS encrypted with TACo, you need the private key:

```bash
npm run recover-all -- \
  --metadata-dir ./data/metadata \
  --output ./decrypted \
  --taco-domain lynx \
  --taco-ritual-id 27 \
  --taco-private-key "0xYOUR_PRIVATE_KEY_HERE"
```

**Important**: Never commit private keys to version control! Use environment variables:

```bash
export TEST_PRIVATE_KEY="0xYOUR_PRIVATE_KEY_HERE"
./quick-recover.sh -m ./data/metadata -o ./decrypted -k $TEST_PRIVATE_KEY
```

### Step 5: Verify Recovered Data

Check the output directory:

```bash
ls -la ./recovered/
# or
ls -la ./decrypted/
```

You should see JSON files named after their CIDs. Open one to verify:

```bash
cat ./recovered/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.json | head -50
```

## Troubleshooting

### Problem: "Failed to retrieve CID from IPFS"

**Solution**: Try a different gateway:
```bash
npm run recover-all -- --metadata-dir ./data/metadata --gateway https://cloudflare-ipfs.com
```

### Problem: "TACo decryption failed"

Possible causes:
1. Ritual is no longer active
2. Private key doesn't match the wallet used for encryption
3. Access conditions aren't satisfied

**Solution**: 
- Verify ritual status on the TACo dashboard
- Double-check the private key
- Ensure the wallet has the required tokens/permissions

### Problem: "Encrypted payload not available"

The encrypted buffer is stored separately from the IPLD conversation. Check:
1. Upload logs for references to encrypted buffers
2. Temporary directories (`/tmp/llm-shim-*.car`)
3. Any backup locations where upload artifacts were saved

## Alternative: Manual Extraction from CAR Files

If you have raw CAR files but no metadata:

```bash
# Extract from CAR file
npm run extract -- ./path/to/file.car --output ./extracted.json

# Or programmatically
node -e "
const { loadLocalCarFile, parseCarFile, extractConversation } = require('./dist/index.js');
(async () => {
  const retrieval = await loadLocalCarFile('./file.car');
  const carData = await parseCarFile(retrieval.carBytes);
  const conversation = await extractConversation(carData);
  console.log(JSON.stringify(conversation, null, 2));
})();
"
```

## Batch Processing Multiple CIDs

Create a file `cids.txt`:
```
bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
bafybeidxfmwv5jxqk3qxqvz3xw5qvxqxqxqxqxqxqxqxqxqxqxqxqxqxq
bafybeiccfclkpucu6lk6dfcs6vi2nu7ry2vdyve4hduzjqxqmqfqxqmqmq
```

Then run:
```bash
npm run recover-all -- --cid-file cids.txt --output ./batch-recovered
```

## Output Format

Recovered conversations are saved as JSON with this structure:

```json
{
  "version": "1.0.0",
  "request": {
    "model": "gpt-4",
    "messages": [
      { "role": "user", "content": "Hello!" },
      { "role": "assistant", "content": "Hi there!" }
    ]
  },
  "response": {
    "id": "chatcmpl-xxx",
    "choices": [...],
    "usage": {...}
  },
  "metadata": {
    "shim_version": "2.0.0",
    "capture_timestamp": 1704067200000
  },
  "timestamp": 1704067200000
}
```

## Contact

For issues or questions about data recovery, contact the LM Studio Bridge team or refer to the main README.md.
