# LM Studio Bridge Data Recovery - Summary

## What Was Created

This week, I've set up a complete data recovery infrastructure for the LM Studio Bridge testing data. The `data-recovery/` directory contains everything your team needs to restore testing data stored on IPFS/Synapse with TACo encryption.

## Directory Structure

```
data-recovery/
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── README.md                 # Main documentation
├── GUIDE.md                  # Step-by-step recovery guide
├── .env.example              # Environment variable template
├── .gitignore                # Git ignore rules
├── example-cids.txt          # Example CID list file
├── quick-recover.sh          # Quick start bash script
└── src/
    ├── index.ts              # Main entry point (API exports)
    ├── cli.ts                # Command-line interface
    ├── types.ts              # TypeScript type definitions
    ├── lib/
    │   ├── retriever.ts      # IPFS/Synapse retrieval
    │   ├── car-extractor.ts  # CAR file parsing
    │   ├── decryptor.ts      # TACo decryption
    │   └── recovery.ts       # Recovery orchestration
    └── utils/                # Additional utilities
```

## Key Capabilities

### 1. IPFS Retrieval
- Fetch CAR files from public IPFS gateways
- Automatic fallback between multiple gateways
- Support for Synapse/Filecoin network (optional)
- Local CAR file loading

### 2. CAR File Extraction
- Parse IPLD CAR files
- Reconstruct conversation DAGs
- Extract requests, responses, and metadata
- Export to JSON format

### 3. TACo Decryption
- Decrypt hybrid AES-GCM + TACo encrypted data
- Support for datil-dev/datil-test networks
- Wallet-based authentication
- Batch decryption support

### 4. Recovery Orchestration
- Single CID recovery
- Batch recovery from metadata directory
- Batch recovery from CID list file
- Progress reporting and error handling

## Quick Start for Next Week's Team

### Option 1: Using the Quick Script

```bash
cd data-recovery
npm install
./quick-recover.sh -m ./data/metadata -o ./recovered
```

### Option 2: Using npm Commands

```bash
cd data-recovery
npm install
npm run build

# List available CIDs
npm run list -- --metadata-dir ./data/metadata

# Recover all
npm run recover-all -- --metadata-dir ./data/metadata --output ./recovered
```

### Option 3: Programmatic API

```typescript
import { recoverConversation } from './data-recovery';

const result = await recoverConversation(
  { type: 'cid', cid: 'bafy...' },
  { outputDir: './recovered' }
);
```

## Important Files to Preserve

1. **Metadata JSON files** - Contains CIDs and encryption info
2. **Private keys** - Required for TACo decryption (store securely!)
3. **Upload logs** - May contain references to encrypted buffers

## Environment Variables Needed

For full decryption capability, set these in `.env.local`:

```bash
TACO_DOMAIN="lynx"
TACO_RITUAL_ID="27"
TEST_PRIVATE_KEY="0x..."  # Your wallet private key
```

## Common Scenarios

### Scenario A: Data was NOT encrypted
```bash
./quick-recover.sh -m ./data/metadata -o ./recovered --skip-decryption
```

### Scenario B: Data WAS encrypted, you have the key
```bash
./quick-recover.sh -m ./data/metadata -o ./decrypted -k $YOUR_PRIVATE_KEY
```

### Scenario C: You only have CIDs (no metadata)
Create `cids.txt` with one CID per line:
```bash
./quick-recover.sh -c cids.txt -o ./recovered
```

### Scenario D: You have raw CAR files
```bash
npm run extract -- ./path/to/file.car --output ./extracted.json
```

## Testing the Setup

To verify everything works:

```bash
cd data-recovery
npm test  # Run any included tests
npm run build  # Verify TypeScript compilation
./quick-recover.sh --help  # Check CLI is working
```

## Documentation References

- **README.md** - Full CLI reference and API docs
- **GUIDE.md** - Detailed step-by-step recovery guide
- **.env.example** - Environment configuration template

## Contact

If you encounter issues:
1. Check the troubleshooting sections in README.md and GUIDE.md
2. Review error messages for specific failure points
3. Verify network connectivity to IPFS gateways
4. Confirm TACo ritual status if decryption fails

---

**Created**: March 9, 2026  
**Purpose**: Enable recovery of LM Studio Bridge testing data from IPFS/TACo
