/**
 * IPNS Manager Module
 *
 * Manages IPNS (InterPlanetary Name System) mutable pointers for:
 * - Latest session CID
 * - Encryption metadata
 * - Configuration
 * - Conversation index
 *
 * Note: This is a stub implementation. Full IPNS support requires @libp2p/crypto
 * and @libp2p/peer-id dependencies for cryptographic key operations.
 *
 * @module ipns-manager
 */

import { CID } from "multiformats/cid";
import * as path from "path";
import * as fs from "fs";

// Dynamic imports for optional dependencies
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = (() => { try { return require("better-sqlite3"); } catch { return null; } })();

// ── Types ───────────────────────────────────────────────────────────────────

export type ResourceType =
  | "latest-session"
  | "encryption-metadata"
  | "config"
  | "conversation-index";

export interface PublishOptions {
  /** Lifetime of the record in milliseconds. Default: 24 hours */
  lifetime?: number;
  /** Time-to-live for caching in milliseconds. Default: 1 hour */
  ttl?: number;
}

export interface IPNSRecord {
  /** The IPNS name (peer ID) */
  name: string;
  /** The CID value this name points to */
  value: CID;
  /** Sequence number for conflict resolution */
  sequence: number;
  /** Validity timestamp (Unix ms) */
  validity: number;
}

export interface IPNSManager {
  /** Generate or load IPNS key for this shim instance */
  initialize(shimId: string): Promise<string>;
  /** Publish a CID to the shim's IPNS name */
  publish(cid: CID, options?: PublishOptions): Promise<IPNSRecord>;
  /** Publish to a specific resource path */
  publishTo(resourceType: ResourceType, cid: CID, options?: PublishOptions): Promise<IPNSRecord>;
  /** Resolve the current CID for an IPNS name */
  resolve(ipnsName: string): Promise<CID>;
  /** Resolve a resource type for this shim */
  resolveResource(resourceType: ResourceType): Promise<CID>;
  /** Get the IPNS name for a specific resource type */
  getResourcePath(resourceType: ResourceType): string;
  /** Get all managed resource names */
  getManagedResources(): ResourceType[];
  /** Get the base IPNS name for this shim */
  getShimId(): string | null;
  /** Close database connection */
  close(): Promise<void>;
}

export interface IPNSManagerOptions {
  /** Database file path for key storage */
  dbPath?: string;
  /** Enable WAL mode */
  enableWAL?: boolean;
  /** Optional key wrapping for security (Lit Protocol integration) */
  keyWrapper?: {
    wrap: (key: Uint8Array) => Promise<Uint8Array>;
    unwrap: (wrapped: Uint8Array) => Promise<Uint8Array>;
  };
}

// ── Database Schema ─────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ipns_keys (
    shim_id TEXT PRIMARY KEY,
    resource_type TEXT DEFAULT '',
    private_key BLOB NOT NULL,
    public_key BLOB NOT NULL,
    peer_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    wrapped BOOLEAN DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS ipns_records (
    peer_id TEXT PRIMARY KEY,
    cid TEXT,
    sequence INTEGER DEFAULT 0,
    published_at INTEGER,
    validity INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_shim_resource ON ipns_keys(shim_id, resource_type);
`;

// ── Stub Implementation ─────────────────────────────────────────────────────

// Stub functions for libp2p crypto operations
// These will be replaced when @libp2p/crypto and @libp2p/peer-id are added

interface StubKeyPair {
  marshal(): Uint8Array;
  public: {
    marshal(): Uint8Array;
  };
}

async function generateKeyPair(_type: string): Promise<StubKeyPair> {
  // Generate a random 64-byte key pair for stubbing
  const privateKey = new Uint8Array(64);
  const publicKey = new Uint8Array(32);
  
  // Fill with random data
  for (let i = 0; i < privateKey.length; i++) {
    privateKey[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < publicKey.length; i++) {
    publicKey[i] = Math.floor(Math.random() * 256);
  }
  
  return {
    marshal: () => privateKey,
    public: {
      marshal: () => publicKey,
    },
  };
}

async function peerIdFromKeys(publicKey: Uint8Array, _privateKey: Uint8Array): Promise<{ toString(): string }> {
  // Generate a deterministic peer ID from the public key hash
  const { sha256 } = await import("multiformats/hashes/sha2");
  const hash = await sha256.digest(publicKey);
  // Create a base58-like string from the hash
  const peerId = "12D3KooW" + Buffer.from(hash.digest.slice(0, 16)).toString("base64url").replace(/[^a-zA-Z0-9]/g, "");
  return {
    toString: () => peerId,
  };
}

// ── Implementation ───────────────────────────────────────────────────────────

export function createIPNSManager(options?: IPNSManagerOptions): IPNSManager {
  const dbPath = options?.dbPath ?? path.resolve("./data/ipns-keys.db");
  const enableWAL = options?.enableWAL ?? true;
  const keyWrapper = options?.keyWrapper;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open database
  const db = new Database(dbPath);

  if (enableWAL) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }

  // Initialize schema
  db.exec(SCHEMA);

  // Prepare statements
  const getKeyStmt = db.prepare(
    "SELECT * FROM ipns_keys WHERE shim_id = ? AND resource_type = ?"
  );
  const storeKeyStmt = db.prepare(
    "INSERT OR REPLACE INTO ipns_keys (shim_id, resource_type, private_key, public_key, peer_id, created_at, wrapped) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const getRecordStmt = db.prepare("SELECT * FROM ipns_records WHERE peer_id = ?");
  const updateRecordStmt = db.prepare(
    "INSERT OR REPLACE INTO ipns_records (peer_id, cid, sequence, published_at, validity) VALUES (?, ?, ?, ?, ?)"
  );

  // State
  let currentShimId: string | null = null;
  const resourceKeys = new Map<ResourceType, { peerId: string; privateKey: Uint8Array }>();

  const manager: IPNSManager = {
    async initialize(shimId: string): Promise<string> {
      currentShimId = shimId;

      // Check if we already have keys for this shim
      const baseKey = getKeyStmt.get(shimId, "") as
        | {
            shim_id: string;
            private_key: Buffer;
            public_key: Buffer;
            peer_id: string;
          }
        | undefined;

      if (baseKey) {
        // Use existing key
        const isWrapped = (baseKey as unknown as { wrapped?: boolean }).wrapped;
        const privateKey = isWrapped && keyWrapper
          ? await keyWrapper.unwrap(new Uint8Array(baseKey.private_key))
          : new Uint8Array(baseKey.private_key);

        resourceKeys.set("latest-session", {
          peerId: baseKey.peer_id,
          privateKey,
        });

        return baseKey.peer_id;
      }

      // Generate new key pair
      const keyPair = await generateKeyPair("Ed25519");
      const privateKey = keyPair.marshal().subarray(0, 32); // Private key bytes
      const publicKey = keyPair.public.marshal();
      const peerId = await peerIdFromKeys(publicKey, privateKey);

      // Optionally wrap the key
      let storedPrivateKey = privateKey;
      let wrapped = false;
      if (keyWrapper) {
        storedPrivateKey = await keyWrapper.wrap(privateKey);
        wrapped = true;
      }

      // Store in database
      storeKeyStmt.run(
        shimId,
        "",
        storedPrivateKey,
        publicKey,
        peerId.toString(),
        Date.now(),
        wrapped
      );

      resourceKeys.set("latest-session", {
        peerId: peerId.toString(),
        privateKey,
      });

      console.log(`[ipns-manager] Initialized IPNS for shim ${shimId}: ${peerId}`);

      return peerId.toString();
    },

    async publish(cid: CID, options?: PublishOptions): Promise<IPNSRecord> {
      const baseKey = resourceKeys.get("latest-session");
      if (!baseKey) {
        throw new Error("IPNS manager not initialized. Call initialize() first.");
      }

      const lifetime = options?.lifetime ?? 24 * 60 * 60 * 1000; // 24 hours

      // Get current sequence number
      const existing = getRecordStmt.get(baseKey.peerId) as
        | { sequence: number }
        | undefined;
      const sequence = (existing?.sequence ?? 0) + 1;

      // Create IPNS record
      const validity = Date.now() + lifetime;

      // In a real implementation, we would sign and publish via libp2p
      // For now, we store the record locally
      updateRecordStmt.run(
        baseKey.peerId,
        cid.toString(),
        sequence,
        Date.now(),
        validity
      );

      console.log(`[ipns-manager] Published ${cid} to ${baseKey.peerId} (seq: ${sequence})`);

      return {
        name: baseKey.peerId,
        value: cid,
        sequence,
        validity,
      };
    },

    async publishTo(
      resourceType: ResourceType,
      cid: CID,
      options?: PublishOptions
    ): Promise<IPNSRecord> {
      if (!currentShimId) {
        throw new Error("IPNS manager not initialized. Call initialize() first.");
      }

      // Get or create key for this resource type
      let keyInfo = resourceKeys.get(resourceType);
      if (!keyInfo) {
        // Check database
        const stored = getKeyStmt.get(currentShimId, resourceType) as
          | {
              private_key: Buffer;
              public_key: Buffer;
              peer_id: string;
              wrapped: number;
            }
          | undefined;

        if (stored) {
          const privateKey = stored.wrapped && keyWrapper
            ? await keyWrapper.unwrap(new Uint8Array(stored.private_key))
            : new Uint8Array(stored.private_key);

          keyInfo = {
            peerId: stored.peer_id,
            privateKey,
          };
        } else {
          // Generate new key pair for this resource
          const keyPair = await generateKeyPair("Ed25519");
          const privateKey = keyPair.marshal().subarray(0, 32);
          const publicKey = keyPair.public.marshal();
          const peerId = await peerIdFromKeys(publicKey, privateKey);

          let storedPrivateKey = privateKey;
          let wrapped = false;
          if (keyWrapper) {
            storedPrivateKey = await keyWrapper.wrap(privateKey);
            wrapped = true;
          }

          storeKeyStmt.run(
            currentShimId,
            resourceType,
            storedPrivateKey,
            publicKey,
            peerId.toString(),
            Date.now(),
            wrapped
          );

          keyInfo = {
            peerId: peerId.toString(),
            privateKey,
          };

          console.log(`[ipns-manager] Created IPNS key for ${resourceType}: ${peerId}`);
        }

        resourceKeys.set(resourceType, keyInfo);
      }

      const lifetime = options?.lifetime ?? 24 * 60 * 60 * 1000;
      const existing = getRecordStmt.get(keyInfo.peerId) as
        | { sequence: number }
        | undefined;
      const sequence = (existing?.sequence ?? 0) + 1;
      const validity = Date.now() + lifetime;

      updateRecordStmt.run(
        keyInfo.peerId,
        cid.toString(),
        sequence,
        Date.now(),
        validity
      );

      console.log(
        `[ipns-manager] Published ${cid} to ${resourceType} (${keyInfo.peerId})`
      );

      return {
        name: keyInfo.peerId,
        value: cid,
        sequence,
        validity,
      };
    },

    async resolve(ipnsName: string): Promise<CID> {
      // In a real implementation, this would resolve via DHT or IPFS node
      // For now, we check our local records
      const record = getRecordStmt.get(ipnsName) as
        | { cid: string; validity: number }
        | undefined;

      if (!record) {
        throw new Error(`No IPNS record found for ${ipnsName}`);
      }

      if (record.validity < Date.now()) {
        throw new Error(`IPNS record for ${ipnsName} has expired`);
      }

      return CID.parse(record.cid);
    },

    async resolveResource(resourceType: ResourceType): Promise<CID> {
      const keyInfo = resourceKeys.get(resourceType);
      if (!keyInfo) {
        throw new Error(`No IPNS key found for resource type: ${resourceType}`);
      }

      return this.resolve(keyInfo.peerId);
    },

    getResourcePath(resourceType: ResourceType): string {
      const keyInfo = resourceKeys.get(resourceType);
      if (!keyInfo) {
        throw new Error(`No IPNS key found for resource type: ${resourceType}`);
      }
      return keyInfo.peerId;
    },

    getManagedResources(): ResourceType[] {
      return Array.from(resourceKeys.keys());
    },

    getShimId(): string | null {
      return currentShimId;
    },

    async close(): Promise<void> {
      db.close();
    },
  };

  return manager;
}

// ── Singleton Instance ──────────────────────────────────────────────────────

let globalIPNSManager: IPNSManager | null = null;

export function getGlobalIPNSManager(options?: IPNSManagerOptions): IPNSManager {
  if (!globalIPNSManager) {
    globalIPNSManager = createIPNSManager(options);
  }
  return globalIPNSManager;
}

export function resetGlobalIPNSManager(): void {
  if (globalIPNSManager) {
    globalIPNSManager.close().catch(console.error);
    globalIPNSManager = null;
  }
}
