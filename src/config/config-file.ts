/**
 * Configuration file manager.
 *
 * Handles reading, writing, and validating ShimConfig files.
 * Config files are stored as JSON with a `.json` extension.
 *
 * Default config path: ./llm-shim.config.json
 */

import * as fs from "fs/promises";
import * as path from "path";
import { ShimConfig, createDefaultConfig } from "./types.js";

/** Default config file path */
export const DEFAULT_CONFIG_PATH = "./llm-shim.config.json";

/**
 * Validation result for a config file.
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Check if a config file exists at the given path.
 */
export async function configFileExists(
  configPath: string = DEFAULT_CONFIG_PATH
): Promise<boolean> {
  try {
    await fs.access(configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a configuration file.
 *
 * @param configPath - Path to the config file
 * @returns The parsed ShimConfig
 * @throws If the file doesn't exist or is invalid JSON
 */
export async function readConfigFile(
  configPath: string = DEFAULT_CONFIG_PATH
): Promise<ShimConfig> {
  const absolutePath = path.resolve(configPath);

  try {
    const raw = await fs.readFile(absolutePath, "utf-8");
    const parsed = JSON.parse(raw);

    // Merge with defaults to fill in any missing fields (forward compat)
    const defaults = createDefaultConfig();
    const config = deepMerge(defaults, parsed) as ShimConfig;

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Config file not found: ${absolutePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(
        `Config file contains invalid JSON: ${absolutePath}\n  ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * Write a configuration to a JSON file.
 *
 * @param config - The ShimConfig to write
 * @param configPath - Path to write the config file
 */
export async function writeConfigFile(
  config: ShimConfig,
  configPath: string = DEFAULT_CONFIG_PATH
): Promise<void> {
  const absolutePath = path.resolve(configPath);

  // Update lastModified timestamp
  config.lastModified = new Date().toISOString();

  // Ensure directory exists
  const dir = path.dirname(absolutePath);
  await fs.mkdir(dir, { recursive: true });

  const json = JSON.stringify(config, null, 2);
  await fs.writeFile(absolutePath, json + "\n", "utf-8");
}

/**
 * Validate a ShimConfig object.
 *
 * Checks for required fields, valid ranges, and logical consistency.
 */
export function validateConfig(config: ShimConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Version check
  if (config.version !== 1) {
    errors.push(
      `Unsupported config version: ${config.version}. Expected 1.`
    );
  }

  // Mode validation
  if (!["server", "client"].includes(config.mode)) {
    errors.push(
      `Invalid mode: "${config.mode}". Must be "server" or "client".`
    );
  }

  // Client bridge validation
  if (config.mode === "client") {
    if (!["webrtc", "libp2p"].includes(config.clientBridge.transport)) {
      errors.push(
        `Invalid client transport: "${config.clientBridge.transport}". Must be "webrtc" or "libp2p".`
      );
    }
    if (config.clientBridge.transport === "webrtc" && !config.clientBridge.shimUrl) {
      errors.push(
        "clientBridge.shimUrl is required for WebRTC client mode."
      );
    }
    if (config.clientBridge.transport === "libp2p" && !config.clientBridge.peerID) {
      errors.push(
        "clientBridge.peerID is required for libp2p client mode."
      );
    }
    if (config.clientBridge.timeoutMs < 0) {
      errors.push(
        `Invalid client timeout: ${config.clientBridge.timeoutMs}. Must be >= 0.`
      );
    }
    if (config.clientBridge.shimUrl) {
      try {
        new URL(config.clientBridge.shimUrl);
      } catch {
        errors.push(
          `Invalid clientBridge.shimUrl: "${config.clientBridge.shimUrl}". Must be a valid URL.`
        );
      }
    }
  }

  // Transport validation
  if (!["http", "webrtc", "libp2p"].includes(config.transport.mode)) {
    errors.push(
      `Invalid transport mode: "${config.transport.mode}". Must be "http", "webrtc", or "libp2p".`
    );
  }
  if (config.transport.port < 1 || config.transport.port > 65535) {
    errors.push(
      `Invalid port: ${config.transport.port}. Must be 1-65535.`
    );
  }

  // LM Studio validation
  if (!config.lmstudio.baseUrl) {
    errors.push("lmstudio.baseUrl is required.");
  } else {
    try {
      new URL(config.lmstudio.baseUrl);
    } catch {
      errors.push(
        `Invalid lmstudio.baseUrl: "${config.lmstudio.baseUrl}". Must be a valid URL.`
      );
    }
  }
  if (config.lmstudio.timeoutMs < 0) {
    errors.push(
      `Invalid timeout: ${config.lmstudio.timeoutMs}. Must be >= 0.`
    );
  }

  // Gzip validation
  if (config.middleware.gzip) {
    if (
      config.middleware.gzipLevel < 0 ||
      config.middleware.gzipLevel > 9
    ) {
      errors.push(
        `Invalid gzip level: ${config.middleware.gzipLevel}. Must be 0-9.`
      );
    }
  }

  // Encryption validation
  if (config.middleware.tacoEncrypt) {
    if (!config.encryption.daoContract) {
      errors.push(
        "encryption.daoContract is required when taco-encrypt is enabled."
      );
    }
    if (
      config.encryption.tacoRitualId <= 0 ||
      isNaN(config.encryption.tacoRitualId)
    ) {
      errors.push(
        `Invalid tacoRitualId: ${config.encryption.tacoRitualId}. Must be a positive integer.`
      );
    }
  }

  // Upload validation
  if (config.middleware.upload) {
    if (
      !config.upload.synapsePrivateKey &&
      !process.env.HAVEN_PRIVATE_KEY
    ) {
      warnings.push(
        "upload.synapsePrivateKey is not set and HAVEN_PRIVATE_KEY env var is not found. Upload will fail at runtime."
      );
    }
    if (config.upload.batchSize < 1) {
      errors.push(
        `Invalid batchSize: ${config.upload.batchSize}. Must be >= 1.`
      );
    }
  }

  // Libp2p validation
  if (config.transport.mode === "libp2p") {
    if (!config.libp2p.protocol.startsWith("/x/")) {
      errors.push(
        `Invalid libp2p protocol: "${config.libp2p.protocol}". Must start with /x/.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Pretty-print a config to the console for review.
 */
export function printConfig(config: ShimConfig): void {
  console.log();
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║         Current Configuration                ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  console.log(`  Mode: ${config.mode === "client" ? "Client Bridge" : "Server (LM Studio Proxy)"}`);
  console.log();

  if (config.description) {
    console.log(`  Description: ${config.description}`);
    console.log();
  }

  // ── Client mode display ──
  if (config.mode === "client") {
    console.log("  ── Client Bridge ──");
    console.log(`    Transport:      ${config.clientBridge.transport}`);
    if (config.clientBridge.transport === "webrtc") {
      console.log(`    Shim URL:       ${config.clientBridge.shimUrl || "(not set)"}`);
      console.log(`    Signaling Port: ${config.clientBridge.signalingPort === 0 ? "auto" : config.clientBridge.signalingPort}`);
    } else {
      console.log(`    Peer ID:        ${config.clientBridge.peerID || "(not set)"}`);
    }
    console.log(`    Local Host:     ${config.clientBridge.localHost}`);
    console.log(`    Local Port:     ${config.transport.port}`);
    console.log(`    Timeout:        ${config.clientBridge.timeoutMs}ms`);
    console.log();

    if (config.clientBridge.transport === "libp2p") {
      console.log("  ── Libp2p ──");
      console.log(`    Protocol:     ${config.libp2p.protocol}`);
      console.log(`    IPFS API URL: ${config.libp2p.ipfsApiUrl}`);
      console.log();
    }

    console.log(`  Last Modified: ${config.lastModified}`);
    console.log(`  Config Version: ${config.version}`);
    console.log();
    return;
  }

  // ── Server mode display ──
  console.log("  ── Transport ──");
  console.log(`    Mode:    ${config.transport.mode}`);
  console.log(`    Port:    ${config.transport.port}`);
  console.log(`    Host:    ${config.transport.host}`);
  console.log();

  console.log("  ── LM Studio ──");
  console.log(`    Base URL:  ${config.lmstudio.baseUrl}`);
  console.log(`    API Token: ${config.lmstudio.apiToken ? "****" + config.lmstudio.apiToken.slice(-4) : "(none)"}`);
  console.log(`    Timeout:   ${config.lmstudio.timeoutMs === 0 ? "no timeout" : config.lmstudio.timeoutMs + "ms"}`);
  console.log();

  console.log("  ── Middleware Pipeline ──");
  console.log(`    Logger:       ${config.middleware.logger ? "✓ enabled" : "✗ disabled"}`);
  console.log(`    Gzip:         ${config.middleware.gzip ? `✓ enabled (level=${config.middleware.gzipLevel})` : "✗ disabled"}`);
  console.log(`    TACo Encrypt: ${config.middleware.tacoEncrypt ? "✓ enabled" : "✗ disabled"}`);
  console.log(`    Upload:       ${config.middleware.upload ? "✓ enabled" : "✗ disabled"}`);
  console.log();

  if (config.middleware.tacoEncrypt) {
    console.log("  ── Encryption (TACo) ──");
    console.log(`    Domain:       ${config.encryption.tacoDomain}`);
    console.log(`    Ritual ID:    ${config.encryption.tacoRitualId}`);
    console.log(`    DAO Contract: ${config.encryption.daoContract || "(not set)"}`);
    console.log(`    DAO Chain:    ${config.encryption.daoChain}`);
    console.log(`    Min Balance:  ${config.encryption.daoMinBalance}`);
    if (config.encryption.keyMetadataPath) {
      console.log(`    Key Metadata: ${config.encryption.keyMetadataPath}`);
    }
    console.log();
  }

  if (config.middleware.upload) {
    console.log("  ── Upload (Synapse / Filecoin) ──");
    console.log(`    Private Key:  ${config.upload.synapsePrivateKey ? "****" + config.upload.synapsePrivateKey.slice(-4) : "(not set / env)"}`);
    console.log(`    RPC URL:      ${config.upload.synapseRpcUrl}`);
    console.log(`    Batch Size:   ${config.upload.batchSize}`);
    console.log(`    Registry:     ${config.upload.registryPath}`);
    console.log();
  }

  if (config.transport.mode === "libp2p") {
    console.log("  ── Libp2p ──");
    console.log(`    Protocol:     ${config.libp2p.protocol}`);
    console.log(`    IPFS API URL: ${config.libp2p.ipfsApiUrl}`);
    console.log();
  }

  console.log(`  ── CID Recorder ──`);
  console.log(`    Output Dir: ${config.cidRecorder.outputDir}`);
  console.log();

  console.log(`  Last Modified: ${config.lastModified}`);
  console.log(`  Config Version: ${config.version}`);
  console.log();
}

/**
 * Deep merge two objects. Source values override target values.
 * Arrays are replaced, not merged.
 */
function deepMerge(
  target: Record<string, any>,
  source: Record<string, any>
): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
