# LLM Shim IPLD Architecture

## Overview

This document describes the IPLD-native architecture of the LLM Shim, which uses granular, content-addressed data structures for efficient storage and retrieval.

## Key Components

### 1. CID Cache Module (`src/lib/cid-cache.ts`)

**Purpose:** Prevents re-uploading identical content to Filecoin.

**Features:**
- SQLite-based persistent cache
- TTL-based cleanup for stale entries
- Batch operations for bulk lookups
- Statistics tracking for deduplication metrics

**Usage:**
```typescript
const cache = createCIDCache({ dbPath: './data/cid-cache.db' });

// Before uploading
if (await cache.has(cid)) {
  console.log('Content already exists, skipping upload');
  return cachedCid;
}

// After successful upload
await cache.add(cid, { size, uploadedAt: Date.now(), dealStatus: 'pending', mimeType });
```

### 2. CID Verification Module (`src/lib/cid-verify.ts`)

**Purpose:** Cryptographically verifies fetched content matches expected CIDs.

**Features:**
- Multi-codec support (raw, json, dag-json)
- Gateway fallback with verification at each hop
- IPLD DAG traversal with per-block verification
- Batch fetch operations

**Usage:**
```typescript
const result = await fetchAndVerify(cid, 'https://ipfs.io/ipfs', {
  codec: 'dag-json',
  timeoutMs: 30000,
});

if (result.verification.valid) {
  console.log('Content verified:', result.data);
}
```

### 3. IPLD Builder Module (`src/lib/ipld-builder.ts`)

**Purpose:** Constructs IPLD DAGs from conversation data.

**Features:**
- Granular message nodes for deduplication
- Separate request/response nodes
- System prompt deduplication via cache
- CAR file generation

**Usage:**
```typescript
const builder = createIPLDBuilder();
const root = await builder.buildConversation(request, response, {
  promptCache,
  previousConversation: lastCid,
});

console.log(`Created ${root.blockCount} blocks, ${root.totalSize} bytes`);
```

### 4. Prompt Cache Module (`src/lib/prompt-cache.ts`)

**Purpose:** Deduplicates system prompts across conversations.

**Features:**
- Content-addressed prompt storage
- Reuse statistics tracking
- LRU eviction when cache is full
- Persistence across restarts

**Usage:**
```typescript
const cache = createPromptCache();
const cachedCid = await cache.get(systemPrompt);

if (cachedCid) {
  // Reuse existing CID
} else {
  const cid = await builder.buildMessage({ role: 'system', content: systemPrompt });
  await cache.set(systemPrompt, cid);
}
```

### 5. IPNS Manager (`src/lib/ipns-manager.ts`)

**Purpose:** Manages mutable pointers to immutable IPLD data.

**Features:**
- Multiple IPNS names per shim instance
- Secure key storage with optional wrapping
- Sequence numbers for conflict resolution
- Resource-type specific names

**Usage:**
```typescript
const ipns = createIPNSManager();
await ipns.initialize('my-shim');

// Publish latest session
await ipns.publish(sessionCid);

// Publish conversation index
await ipns.publishTo('conversation-index', indexCid);
```

### 6. Session Chain (`src/lib/session-chain.ts`)

**Purpose:** Links sessions into an immutable chain for history tracking.

**Features:**
- Automatic session linking
- Statistics aggregation
- Resume after restart
- IPNS publishing on session end

**Usage:**
```typescript
const chain = createSessionChain({ ipnsManager });
await chain.startSession();

// Add conversations
await chain.addConversation(conversationCid);

// End and publish
const sessionCid = await chain.endSession();
```

### 7. Conversation Index (`src/lib/conversation-index.ts`)

**Purpose:** Searchable index of conversations for efficient lookup.

**Features:**
- Paginated results
- Full-text search
- Model/time/token filtering
- IPNS publishing

**Usage:**
```typescript
const indexer = createConversationIndexer();
await indexer.indexConversation(cid, {
  model: 'gpt-4',
  timestamp: Date.now(),
  firstUserMessage: 'Hello',
  tokenCount: 150,
});

// Query
const results = await indexer.query({
  model: 'gpt-4',
  searchText: 'hello',
});
```

### 8. Streaming IPLD Builder (`src/lib/streaming-ipld.ts`)

**Purpose:** Builds IPLD DAGs incrementally from streaming responses.

**Features:**
- Real-time block creation
- Chunk-level granularity
- Abort support
- Performance metrics

**Usage:**
```typescript
const builder = createStreamingIPLDBuilder();
await builder.startRequest(request);

// As chunks arrive
for await (const chunk of responseStream) {
  await builder.streamResponseChunk(chunk);
}

// Finalize
const { rootCid } = await builder.finalize(responseMetadata);
```

## Data Flow

### Upload Flow (IPLD)

```
1. Request/Response captured
   ↓
2. Generate local CID (for dedup check)
   ↓
3. Check CID cache
   ↓
   ├─ Exists → Skip upload, log deduplication
   ↓
   └─ New → Continue
      ↓
4. Build IPLD DAG (messages → request/response → root)
   ↓
5. System prompt deduplication
   ↓
6. Create CAR file from blocks
   ↓
7. Upload CAR to Filecoin
   ↓
8. Add CID to cache
   ↓
9. Record component CIDs
   ↓
10. Update session chain
   ↓
11. Publish to IPNS
```

### Retrieval Flow

```
1. Resolve IPNS name to CID
   ↓
2. Fetch and verify root block
   ↓
3. Traverse DAG to find component
   ↓
4. Verify each block's CID
   ↓
5. Reassemble content
   ↓
6. Decrypt if encrypted
   ↓
7. Decompress if compressed
   ↓
8. Return data
```

## IPLD Schema

```ipldsch
type Conversation struct {
  version String (default "1.0.0")
  request Request
  response Response
  metadata Metadata
  timestamp Int
  previousConversation optional Link<Conversation>
}

type Message struct {
  role String
  content String
}

type Request struct {
  model String
  messages [Link<Message>]
  parameters optional RequestParameters
}

type Response struct {
  id String
  model String
  choices [Choice]
  usage Usage
  created Int
}
```

## Performance Targets

| Metric | Target | How Achieved |
|--------|--------|--------------|
| Deduplication Rate | 20% | System prompt cache, CID cache |
| Retrieval Time (single message) | 10x faster | IPLD DAG traversal, partial retrieval |
| Storage Cost Reduction | Measurable | CAR files, deduplication |
| Verification Coverage | 100% | Mandatory CID verification |
| Session Recovery | 100% | Persistent session chain |

## Configuration

### Environment Variables

```bash
# CID Cache
CID_CACHE_PATH=./data/cid-cache.db
CID_CACHE_TTL_DAYS=90

# IPNS
IPNS_KEYS_PATH=./data/ipns-keys.db

# Sessions
SESSION_CHAIN_PATH=./data/session-chain.db

# Index
CONVERSATION_INDEX_PATH=./data/conversation-index.db
PROMPT_CACHE_PATH=./data/prompt-cache.db
```

### Middleware Options

```typescript
interface UploadMiddlewareOptions {
  synapseUpload: SynapseUploadFn;
  cidCache?: CIDCache;
  promptCache?: PromptCache;
  sessionChain?: SessionChain;
  ipnsManager?: IPNSManager;
  indexer?: ConversationIndexer;
  useStreaming?: boolean;
}
```

## IPLD-Native Architecture

### Key Design Principles

1. **IPLD-Only Storage**: All data uses IPLD structures exclusively
2. **IPLD-Only Upload Flow**:
   - Request/Response → IPLD DAG (messages → request/response → root)
   - CAR file creation from IPLD blocks
   - Upload CAR to Filecoin
   - Cache root CID and all component CIDs

### Benefits

- **Simplified Code**: Single-path maintenance
- **Consistent Data**: All stored data follows the same IPLD schema
- **Full Deduplication**: System prompts and messages deduplicated across all conversations
- **Granular Retrieval**: Individual messages fetchable by CID without downloading full conversation
- **Verified Integrity**: All retrieved content verified against CID

### Data Structure

```
ConversationRoot
├── version: "1.0.0"
├── timestamp: number
├── request: CID → RequestNode
│   ├── model: string
│   ├── messages: CID[] → MessageNode[]
│   └── parameters: object
├── response: CID → ResponseNode
│   ├── id: string
│   ├── model: string
│   ├── choices: CID[] → ChoiceNode[]
│   └── usage: object
├── metadata: CID → MetadataNode
│   ├── shim_version: string
│   └── capture_timestamp: number
└── previousConversation: CID (optional)
```

### Data Format

All conversations use the IPLD-native format exclusively:
- CIDs are content-addressed and verifiable
- Data is stored in CAR files for efficient retrieval
- Individual messages are accessible by CID

## Security Considerations

1. **Content Verification:** All CIDs verified on retrieval
2. **Key Storage:** Private keys stored encrypted (optional TACo wrapping)
3. **Immutable History:** Session chain prevents tampering
4. **Access Control:** TACo for encryption key management

## Future Enhancements

1. Graph sync for efficient DAG replication
2. Bitswap integration for P2P retrieval
3. Content routing via DHT
4. Multi-writer IPNS for distributed shims
