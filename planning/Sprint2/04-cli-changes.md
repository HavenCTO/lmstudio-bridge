# S2-T4: Update CLI Options for TACo Integration

**Owner:** Backend Engineer  
**Estimated Effort:** 0.5 days  
**Dependencies:** S2-T3 (middleware rewritten)  
**Acceptance Criteria:**
- [ ] `--lit-network` flag removed from `src/index.ts`
- [ ] `--lit-chain` flag repurposed as `--dao-chain`
- [ ] New flags added: `--taco-domain`, `--dao-contract`
- [ ] Help text updated to reflect TACo terminology
- [ ] Default values set appropriately (DEVNET, ritualId=27)
- [ ] Error handling for missing required options

---

## Technical Specification

### Old CLI Flags (Lit Protocol)

```typescript
.option("--encrypt", "Enable Lit Protocol hybrid encryption", false)
.option("--lit-network <network>", "Lit network (datil-dev, datil-test, datil)", "datil-dev")
.option("--wallet-address <address>", "Wallet address for access control")
.option("--lit-chain <chain>", "EVM chain for ACCs", "ethereum")
```

### New CLI Flags (TACo)

```typescript
.option("--encrypt", "Enable TACo threshold encryption", false)
.option("--taco-domain <domain>", "TACo domain (DEVNET, TESTNET)", "DEVNET")
.option("--dao-contract <address>", "DAO token contract address (required)") 
.option("--dao-chain <chainId>", "Chain ID for DAO token (e.g., 1, 137)", "1")
.option("--dao-token-type <type>", "Token type (ERC20, ERC721)", "ERC20")
.option("--ritual-id <id>", "TACo ritual ID (default: 27 for DEVNET)", "27")
```

### Backwards Compatibility Note

**BREAKING:** Existing scripts using `--lit-network` or `--lit-chain` will fail. These must be updated:

```bash
# OLD (no longer works)
node dist/index.js --encrypt --lit-network datil-dev --wallet-address 0x...

# NEW
node dist/index.js --encrypt --taco-domain DEVNET --dao-contract 0x... --dao-chain 1
```

---

## Implementation Changes

### File: `src/index.ts` (Lines ~85-110)

```typescript
// ── Encrypt middleware (Lit Protocol) ──
// OLD CODE - REMOVE:
.option("--encrypt", "Enable Lit Protocol hybrid encryption", false)
.option(
  "--lit-network <network>",
  "Lit Protocol network (datil-dev, datil-test, datil)",
  "datil-dev"
)
.option(
  "--wallet-address <address>",
  "Wallet address for encryption access control"
)
.option(
  "--lit-chain <chain>",
  "EVM chain for access-control conditions",
  "ethereum"
)

// NEW CODE - ADD:
.option("--encrypt", "Enable TACo threshold encryption", false)
.option(
  "--taco-domain <domain>",
  "TACo domain (DEVNET, TESTNET)",
  "DEVNET"
)
.option(
  "--dao-contract <address>",
  "DAO token contract address (REQUIRED when --encrypt)"
)
.option(
  "--dao-chain <chainId>",
  "Chain ID for DAO token (e.g., 1 = Ethereum mainnet)",
  "1"
)
.option(
  "--dao-token-type <type>",
  "Token type (ERC20, ERC721)",
  "ERC20"
)
.option(
  "--ritual-id <id>",
  "TACo ritual ID (27 for DEVNET, 6 for TESTNET)",
  "27"
)
```

### Option Parsing Updates (Lines ~145-165)

```typescript
const opts = program.opts<{
  // ... other options
  // Encrypt (OLD - REMOVE these)
  // encrypt: boolean;
  // litNetwork: string;
  // walletAddress?: string;
  // litChain: string;
  
  // Encrypt (NEW - ADD these)
  encrypt: boolean;
  tacoDomain: string;
  daoContract?: string;
  daoChain: string;
  daoTokenType: string;
  ritualId: string;
}>();
```

### Validation Logic (Add after option parsing)

```typescript
if (opts.encrypt && !opts.daoContract) {
  console.error(
    "[main] ✗ --dao-contract is required when --encrypt is enabled"
  );
  process.exit(1);
}

if (opts.daomain !== 'DEVNET' && opts.tacoDomain !== 'TESTNET') {
  console.error("[main] ✗ --taco-domain must be DEVNET or TESTNET");
  process.exit(1);
}
```

### Middleware Initialization (Lines ~190-220)

```typescript
if (opts.encrypt) {
  const litPrivateKey =
    opts.synapsePrivateKey || process.env.HAVEN_PRIVATE_KEY;

  litKeyEncryptor = createLitKeyEncryptor({
    network: opts.tacoDomain.toLowerCase(), // Map to expected format
    privateKey: litPrivateKey,
    chain: opts.daoChain,
  });

  encryptHandle = createEncryptMiddleware({
    litEncryptKey: litKeyEncryptor.encrypt,
    litDecryptKey: litPrivateKey ? litKeyEncryptor.decrypt : undefined,
    walletAddress: await deriveAddressFromPrivateKey(litPrivateKey!), // Add helper
    chain: 'ethereum', // Still relevant for some chains
    keyMetadataPath: opts.keyMetadata,
    
    // TACO-SPECIFIC OPTIONS
    tacoRpcUrl: process.env.TACO_RPC_URL,
    tacoRitualId: parseInt(opts.ritualId, 10),
    daoContractAddress: opts.daoContract!,
    daoChainId: parseInt(opts.daoChain, 10),
    daoTokenType: opts.daoTokenType as 'ERC20' | 'ERC721',
  });

  await encryptHandle.initialize();

  engine.use(encryptHandle.middleware);
  console.log(
    `[main] ✓ TACo encryption enabled (domain=${opts.tacoDomain}, ` +
    `contract=${opts.daoContract?.substring(0, 10)}..., ` +
    `chain=${opts.daoChain})`
  );
}
```

---

## Updated Usage Examples

### Basic Encryption (DAO Token Holder Gating)
```bash
node dist/index.js \
  --http \
  --encrypt \
  --daemon DEVNET \
  --dao-contract 0x1234567890123456789012345678901234567890 \
  --da-chain 1 \
  --dao-token-type ERC20 \
  --ritual-id 27
```

### With Session Persistence
```bash
node dist/index.js \
  --encrypt \
  --taco-domain DEVNET \
  --dao-contract 0xDAO_TOKEN_CONTRACT \
  --dao-chain 137 \
  --key-metadata ./session-metadata.json
```

### Full Pipeline (with Filecoin Upload)
```bash
node dist/index.js \
  --http \
  --encrypt \
  --taco-domain DEVNET \
  --dao-contract 0xDAO...\
  --dao-chain 1 \
  --gzip \
  --upload \
  --synapse-private-key $FIL_PRIVATE_KEY
```

---

## Environment Variables (New)

Add to `.env.example`:

```bash
# TACo Configuration
TACO_NETWORK=DEVNET       # DEVNET or TESTNET
TACO_RITUAL_ID=27         # Override default ritual ID
TACO_RPC_URL=https://ethereum-rpc.publicnode.com

# DAO Token Configuration
DAO_TOKEN_CONTRACT_ADDRESS=0x...
DAO_TOKEN_CHAIN_ID=1
DAO_TOKEN_TYPE=ERC20      # or ERC721

# Wallet (for encryptor signing)
WALLET_PRIVATE_KEY=0x...  # Same key used across components
```

---

## Test Plan

### Manual Verification
```bash
# Should show correct help text
node dist/index.js --help | grep -A2 "encrypt"

# Should reject missing --dao-contract
node dist/index.js --encrypt 2>&1 | grep "dao-contract is required"

# Should accept valid configuration (will fail later due to missing RPC, but flags parsed ok)
node dist/index.js --encrypt --taco-domain DEVNET --dao-contract 0xTest --dao-chain 1 2>&1 | grep "initialising\|initializing"
```

---

## Dependencies
- Depends on S2-T3 (new middleware implementation)
- Blocks deployment/testing of full TACo integration

---

## Success Metrics
- ✅ All old Lit flags removed/renamed
- ✅ New flags have clear help text AND sensible defaults
- ✅ Validation rejects incomplete configurations early
- ✅ README.md / CLI reference updated

---

**Status:** PENDING  
**Created:** 2026-03-09  
**Target Completion:** Day 4 of Sprint 2
