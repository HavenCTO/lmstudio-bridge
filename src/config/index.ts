/**
 * Configuration module barrel export.
 *
 * Priority for resolving configuration:
 *   1. CLI flags / URL params (highest priority — override everything)
 *   2. Config file (if --config is specified or default file exists)
 *   3. Guided wizard (if no config file and no CLI flags provided)
 */

export { ShimConfig, createDefaultConfig } from "./types.js";
export type {
  TransportConfig,
  LMStudioConfig,
  MiddlewareConfig,
  UploadConfig,
  EncryptionConfig,
  Libp2pConfig,
  CidRecorderConfig,
  ClientBridgeConfig,
} from "./types.js";

export {
  DEFAULT_CONFIG_PATH,
  configFileExists,
  readConfigFile,
  writeConfigFile,
  validateConfig,
  printConfig,
} from "./config-file.js";
export type { ConfigValidationResult } from "./config-file.js";

export { runConfigWizard } from "./wizard.js";

import { ShimConfig, createDefaultConfig } from "./types.js";
import {
  DEFAULT_CONFIG_PATH,
  configFileExists,
  readConfigFile,
  validateConfig,
  printConfig,
} from "./config-file.js";
import { runConfigWizard } from "./wizard.js";

/**
 * Represents the parsed CLI options from Commander.
 * This mirrors the opts type in index.ts.
 */
export interface CLIOptions {
  // Mode
  client: boolean;
  webrtc: boolean;
  port: string;
  host: string;
  lmstudioUrl: string;
  lmstudioToken?: string;
  timeout: string;
  logger: boolean;
  gzip: boolean;
  gzipLevel: string;
  tacoEncrypt: boolean;
  tacoDomain: string;
  tacoRitualId: string;
  daoContract?: string;
  daoChain: string;
  daoMinBalance: string;
  upload: boolean;
  synapsePrivateKey?: string;
  synapseRpcUrl: string;
  batchSize: string;
  registryPath: string;
  keyMetadata?: string;
  cidLog?: string;
  libp2p: boolean;
  libp2pProtocol: string;
  ipfsApiUrl: string;
  // Config-specific options
  config?: string;
  // Client bridge options
  shimUrl?: string;
  peerid?: string;
  clientHost?: string;
  signalingPort: string;
  clientTimeout: string;
}

/**
 * Check if the user provided any meaningful CLI flags beyond defaults.
 * This helps determine whether to fall through to config file or wizard.
 */
export function hasExplicitCLIFlags(argv: string[]): boolean {
  // These are flags that indicate the user is explicitly configuring via CLI
  const significantFlags = [
    "--client",
    "--webrtc",
    "--libp2p",
    "--gzip",
    "--taco-encrypt",
    "--upload",
    "--lmstudio-url",
    "--lmstudio-token",
    "--port",
    "--host",
    "--timeout",
    "--no-logger",
    "--gzip-level",
    "--taco-domain",
    "--taco-ritual-id",
    "--dao-contract",
    "--dao-chain",
    "--dao-min-balance",
    "--synapse-private-key",
    "--synapse-rpc-url",
    "--batch-size",
    "--registry-path",
    "--key-metadata",
    "--cid-log",
    "--libp2p-protocol",
    "--ipfs-api-url",
    // Client bridge flags
    "--shim-url",
    "--peerid",
    "--client-host",
    "--signaling-port",
    "--client-timeout",
  ];

  return argv.some((arg) => significantFlags.includes(arg));
}

/**
 * Resolve configuration using the priority chain:
 *   1. If --config is specified, load that file
 *   2. If no explicit CLI flags, check for default config file
 *   3. If no config file found and running interactively, launch wizard
 *   4. Otherwise, use defaults
 *
 * CLI flags always override config file values.
 *
 * @param opts - Parsed CLI options
 * @param argv - Raw process.argv for detecting explicit flags
 * @returns Resolved ShimConfig
 */
export async function resolveConfig(
  opts: CLIOptions,
  argv: string[]
): Promise<ShimConfig> {
  const explicitFlags = hasExplicitCLIFlags(argv);
  let config: ShimConfig | null = null;

  // ── Step 1: Try loading config file ──

  if (opts.config) {
    // Explicit --config flag: load that file
    try {
      config = await readConfigFile(opts.config);
      console.log(`[config] ✓ Loaded configuration from ${opts.config}`);
    } catch (error) {
      console.error(
        `[config] ✗ Failed to load config file: ${(error as Error).message}`
      );
      process.exit(1);
    }
  } else if (!explicitFlags) {
    // No explicit CLI flags: check for default config file
    const defaultExists = await configFileExists(DEFAULT_CONFIG_PATH);
    if (defaultExists) {
      try {
        config = await readConfigFile(DEFAULT_CONFIG_PATH);
        console.log(
          `[config] ✓ Loaded configuration from ${DEFAULT_CONFIG_PATH}`
        );
      } catch (error) {
        console.warn(
          `[config] ⚠ Default config file exists but failed to load: ${(error as Error).message}`
        );
        console.warn(`[config]   Falling back to defaults.`);
      }
    } else if (process.stdin.isTTY) {
      // Interactive terminal, no config file, no CLI flags → launch wizard
      console.log(
        "[config] No configuration file found and no CLI flags provided."
      );
      console.log(
        "[config] Launching guided configuration wizard..."
      );
      console.log();
      config = await runConfigWizard();
    }
  }

  // ── Step 2: Start with config file or defaults ──

  if (!config) {
    config = createDefaultConfig();
  }

  // ── Step 3: Override with explicit CLI flags ──
  // CLI flags take highest priority

  if (explicitFlags) {
    applyCliOverrides(config, opts);
  }

  // ── Step 4: Validate ──

  const validation = validateConfig(config);
  if (validation.warnings.length > 0) {
    for (const warn of validation.warnings) {
      console.warn(`[config] ⚠ ${warn}`);
    }
  }
  if (!validation.valid) {
    console.error("[config] ✗ Configuration validation failed:");
    for (const err of validation.errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  return config;
}

/**
 * Apply CLI option overrides to a config object.
 * Only overrides values that were explicitly set via CLI flags.
 */
function applyCliOverrides(config: ShimConfig, opts: CLIOptions): void {
  // Transport
  if (opts.libp2p) {
    config.transport.mode = "libp2p";
  } else if (opts.webrtc) {
    config.transport.mode = "webrtc";
  }
  // Port and host are always provided by Commander (with defaults),
  // so we always apply them when explicit flags are present
  config.transport.port = parseInt(opts.port, 10);
  config.transport.host = opts.host;

  // LM Studio
  config.lmstudio.baseUrl = opts.lmstudioUrl;
  if (opts.lmstudioToken) {
    config.lmstudio.apiToken = opts.lmstudioToken;
  }
  config.lmstudio.timeoutMs = parseInt(opts.timeout, 10);

  // Middleware toggles
  config.middleware.logger = opts.logger !== false;
  config.middleware.gzip = opts.gzip;
  config.middleware.gzipLevel = parseInt(opts.gzipLevel, 10);
  config.middleware.tacoEncrypt = opts.tacoEncrypt;
  config.middleware.upload = opts.upload;

  // Encryption
  config.encryption.tacoDomain = opts.tacoDomain;
  config.encryption.tacoRitualId = parseInt(opts.tacoRitualId, 10);
  if (opts.daoContract) {
    config.encryption.daoContract = opts.daoContract;
  }
  // Parse daoChain as number (chain ID) - support both numeric and named chains
  const chainIdMap: Record<string, number> = {
    'mainnet': 1,
    'sepolia': 11155111,
    'goerli': 5,
    'polygon': 137,
    'amoy': 80002,
    'mumbai': 80001,
  };
  const parsedChainId = parseInt(opts.daoChain, 10);
  config.encryption.daoChain = isNaN(parsedChainId) 
    ? (chainIdMap[opts.daoChain.toLowerCase()] || 11155111) 
    : parsedChainId;

  config.encryption.daoMinBalance = opts.daoMinBalance;
  if (opts.keyMetadata) {
    config.encryption.keyMetadataPath = opts.keyMetadata;
  }

  // Upload
  if (opts.synapsePrivateKey) {
    config.upload.synapsePrivateKey = opts.synapsePrivateKey;
  }
  config.upload.synapseRpcUrl = opts.synapseRpcUrl;
  config.upload.batchSize = parseInt(opts.batchSize, 10);
  config.upload.registryPath = opts.registryPath;

  // Libp2p
  config.libp2p.protocol = opts.libp2pProtocol;
  config.libp2p.ipfsApiUrl = opts.ipfsApiUrl;

  // CID recorder
  if (opts.cidLog) {
    config.cidRecorder.outputDir = opts.cidLog;
  }

  // Mode: --client flag switches to client mode
  if (opts.client) {
    config.mode = "client";
    // In client mode, determine client transport from --webrtc / --libp2p
    if (opts.libp2p) {
      config.clientBridge.transport = "libp2p";
    } else {
      config.clientBridge.transport = "webrtc";
    }
  }

  // Client bridge overrides
  if (opts.shimUrl) {
    config.clientBridge.shimUrl = opts.shimUrl;
  }
  if (opts.peerid) {
    config.clientBridge.peerID = opts.peerid;
  }
  if (opts.clientHost) {
    config.clientBridge.localHost = opts.clientHost;
  }
  if (opts.signalingPort && opts.signalingPort !== "0") {
    config.clientBridge.signalingPort = parseInt(opts.signalingPort, 10);
  }
  if (opts.clientTimeout && opts.clientTimeout !== "120000") {
    config.clientBridge.timeoutMs = parseInt(opts.clientTimeout, 10);
  }
}
