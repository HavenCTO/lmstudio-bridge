/**
 * Configuration types for the LLM Shim middleware.
 *
 * These types define the shape of the configuration file that can be
 * saved/loaded to avoid passing CLI flags every time.
 */

export interface ShimConfig {
  /** Config file format version */
  version: number;

  /** When this config was last modified */
  lastModified: string;

  /** Optional human-readable description */
  description?: string;

  /** Operating mode: "server" (LM Studio proxy) or "client" (remote bridge) */
  mode: "server" | "client";

  /** Transport settings */
  transport: TransportConfig;

  /** LM Studio connection settings (server mode only) */
  lmstudio: LMStudioConfig;

  /** Middleware pipeline settings (server mode only) */
  middleware: MiddlewareConfig;

  /** Upload / Filecoin settings (only relevant if upload is enabled) */
  upload: UploadConfig;

  /** Encryption settings (only relevant if taco-encrypt is enabled) */
  encryption: EncryptionConfig;

  /** Libp2p transport settings (used by both server and client libp2p modes) */
  libp2p: Libp2pConfig;

  /** CID recorder settings */
  cidRecorder: CidRecorderConfig;

  /** Client bridge settings (client mode only) */
  clientBridge: ClientBridgeConfig;
}

export interface TransportConfig {
  /** Transport mode: "http" | "webrtc" | "libp2p" */
  mode: "http" | "webrtc" | "libp2p";
  /** Port for the transport server */
  port: number;
  /** Bind address */
  host: string;
}

export interface LMStudioConfig {
  /** LM Studio base URL */
  baseUrl: string;
  /** LM Studio API token (optional) */
  apiToken?: string;
  /** Request timeout in ms (0 = no timeout) */
  timeoutMs: number;
}

export interface MiddlewareConfig {
  /** Enable built-in logger middleware */
  logger: boolean;
  /** Enable gzip compression */
  gzip: boolean;
  /** Gzip compression level (0-9) */
  gzipLevel: number;
  /** Enable TACo threshold encryption */
  tacoEncrypt: boolean;
  /** Enable Synapse upload to Filecoin */
  upload: boolean;
}

export interface UploadConfig {
  /** Private key for Synapse/Filecoin transactions */
  synapsePrivateKey?: string;
  /** Filecoin RPC URL */
  synapseRpcUrl: string;
  /** Batch size for LLaVA export */
  batchSize: number;
  /** Path to HAMT registry file */
  registryPath: string;
}

export interface EncryptionConfig {
  /** TACo domain (e.g., lynx for DEVNET) */
  tacoDomain: string;
  /** TACo ritual ID for DKG */
  tacoRitualId: number;
  /** DAO token contract address for access control */
  daoContract?: string;
  /** Blockchain chain ID for DAO token checks (e.g., 11155111 for Sepolia) */
  daoChain: number;
  /** Minimum token balance required for access */
  daoMinBalance: string;
  /** Path to persist encryption key metadata JSON */
  keyMetadataPath?: string;
}

export interface Libp2pConfig {
  /** Libp2p protocol name for the tunnel */
  protocol: string;
  /** Kubo IPFS daemon HTTP RPC API URL */
  ipfsApiUrl: string;
}

export interface CidRecorderConfig {
  /** Directory for Parquet CID logs */
  outputDir: string;
}

export interface ClientBridgeConfig {
  /** Client transport: "webrtc" or "libp2p" */
  transport: "webrtc" | "libp2p";
  /** URL of the remote LLM shim's control server (required for WebRTC mode) */
  shimUrl?: string;
  /** PeerID of the remote shim (required for libp2p mode) */
  peerID?: string;
  /** Bind address for the local HTTP proxy server */
  localHost: string;
  /** Port for the ephemeral signaling server (0 = random, WebRTC only) */
  signalingPort: number;
  /** Request timeout for LLM requests in ms */
  timeoutMs: number;
}

/**
 * Returns a default configuration with sensible defaults matching
 * the CLI defaults.
 */
export function createDefaultConfig(): ShimConfig {
  return {
    version: 1,
    lastModified: new Date().toISOString(),
    description: "",
    mode: "server",
    transport: {
      mode: "http",
      port: 8080,
      host: "0.0.0.0",
    },
    lmstudio: {
      baseUrl: "http://localhost:1234",
      timeoutMs: 0,
    },
    middleware: {
      logger: true,
      gzip: false,
      gzipLevel: 6,
      tacoEncrypt: false,
      upload: false,
    },
    upload: {
      synapseRpcUrl: "https://api.calibration.node.glif.io/rpc/v1",
      batchSize: 100,
      registryPath: "./registry.json",
    },
    encryption: {
      tacoDomain: "lynx",
      tacoRitualId: 27,
      daoChain: 11155111, // Sepolia testnet chain ID
      daoMinBalance: "1",
    },
    libp2p: {
      protocol: "/x/llmshim",
      ipfsApiUrl: "http://127.0.0.1:5001",
    },
    cidRecorder: {
      outputDir: "./cids",
    },
    clientBridge: {
      transport: "webrtc",
      localHost: "127.0.0.1",
      signalingPort: 0,
      timeoutMs: 120000,
    },
  };
}
