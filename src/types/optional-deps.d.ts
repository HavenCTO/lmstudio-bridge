/**
 * Type stubs for optional dependencies that may not be installed.
 * These modules are loaded dynamically and only used when available.
 */

// Stub for better-sqlite3
declare module "better-sqlite3" {
  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (message: unknown) => void;
  }

  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    get(...params: unknown[]): unknown | undefined;
    all(...params: unknown[]): unknown[];
  }

  class Database {
    constructor(filename: string, options?: DatabaseOptions);
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(pragma: string): unknown;
    close(): void;
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  }

  export = Database;
}

// Stub for ethers
declare module "ethers" {
  export class Wallet {
    constructor(privateKey: string);
    signMessage(message: string): Promise<string>;
    address: string;
  }
}

// Stub for node-datachannel
declare module "node-datachannel" {
  export interface DataChannel {
    onMessage: (callback: (msg: string) => void) => void;
    sendMessage: (msg: string) => void;
    close: () => void;
  }

  export interface PeerConnection {
    createDataChannel: (label: string) => DataChannel;
    onDataChannel: (callback: (dc: DataChannel) => void) => void;
    setLocalDescription: () => void;
    setRemoteDescription: (sdp: string, type: string) => void;
    addIceCandidate: (candidate: string, mid: string) => void;
    createOffer: () => string;
    createAnswer: () => string;
    close: () => void;
  }

  export function createPeerConnection(
    config: unknown
  ): PeerConnection;
}

// Stub for ipns
interface IPNSRecord {
  value: Uint8Array;
  signature: Uint8Array;
  validity: Uint8Array;
  validityType: number;
  sequence: bigint;
  pubKey?: Uint8Array;
  signatureV2?: Uint8Array;
  data?: Uint8Array;
}

declare module "ipns" {
  export function createFromPrivKey(
    privateKey: Uint8Array,
    value: Uint8Array,
    seq: number,
    lifetime: number
  ): Promise<IPNSRecord>;
  
  export function validate(
    record: IPNSRecord,
    publicKey: Uint8Array
  ): Promise<void>;
}

// Stub for @libp2p/crypto
declare module "@libp2p/crypto/keys" {
  interface KeyPair {
    raw: Uint8Array;
    public: {
      raw: Uint8Array;
      marshal(): Uint8Array;
    };
    marshal(): Uint8Array;
    sign: (data: Uint8Array) => Promise<Uint8Array>;
  }

  export function generateKeyPair(type: string): Promise<KeyPair>;
}

// Stub for @libp2p/peer-id
declare module "@libp2p/peer-id" {
  export function peerIdFromKeys(
    publicKey: Uint8Array,
    privateKey?: Uint8Array
  ): Promise<{ toString(): string; toBytes(): Uint8Array }>;
}
