#!/usr/bin/env node
/**
 * LLM Shim CLI – lightweight proxy that accepts OpenAI-compatible requests
 * and forwards them to LM Studio.
 *
 * Usage:
 *   llm-shim --http              # (default) Start HTTP transport
 *   llm-shim --webrtc            # Start WebRTC transport
 *   llm-shim --http --port 9000  # Custom port
 *   llm-shim --lmstudio-url http://localhost:1234
 *
 * Export commands:
 *   llm-shim export --registry ./registry.json --batch 0 --output ./export
 *   llm-shim export --registry ./registry.json --all --output ./export
 *   llm-shim registry-status --registry ./registry.json
 *
 * Configuration:
 *   llm-shim configure                           # Guided config wizard
 *   llm-shim configure --output ./my-config.json # Save to custom path
 *   llm-shim config-show                         # Show current config
 *   llm-shim config-show --config ./my-config.json
 *   llm-shim --config ./my-config.json           # Start with config file
 *
 * Optional middleware pipeline (applied in order: gzip → encrypt → upload):
 *   llm-shim --gzip                              # Compress responses
 *   llm-shim --gzip --gzip-level 9               # Max compression
 *   llm-shim --taco-encrypt --dao-contract 0x... # TACo threshold encryption
 *   llm-shim --upload --synapse-private-key 0x... # Filecoin upload via Synapse
 *   llm-shim --gzip --taco-encrypt --upload       # Full pipeline
 */

import { Command } from "commander";
import { Engine } from "./pipeline/engine.js";
import { createHttpTransport } from "./transport/http.js";
import { createWebRTCTransport } from "./transport/webrtc.js";
import { createLibp2pTransport } from "./transport/libp2p.js";
import {
  IpfsDaemonNotRunningError,
  Libp2pStreamMountingDisabledError,
  P2PProtocolInUseError,
  PeerIDUnreachableError,
  IpfsApiUrlError,
} from "./utils/ipfs-api.js";
import { startClientBridge } from "./client/client-bridge.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { createGzipMiddleware } from "./middleware/gzip.js";
import {
  createTacoEncryptMiddleware,
  TacoEncryptMiddlewareHandle,
} from "./middleware/taco-encrypt.js";
import {
  createUploadMiddleware,
  createSynapseUploader,
  UploadMiddlewareHandle,
} from "./middleware/upload.js";
import { createCidRecorder, CidRecorderHandle } from "./middleware/cid-recorder.js";
import {
  exportBatchFromCAR,
  LLaVAExporter,
} from "./export/llava-exporter.js";
import {
  createRegistry,
} from "./lib/registry.js";
import {
  resolveConfig,
  readConfigFile,
  configFileExists,
  printConfig,
  validateConfig,
  writeConfigFile,
  DEFAULT_CONFIG_PATH,
  ShimConfig,
  createDefaultConfig,
} from "./config/index.js";
import { runConfigWizard } from "./config/wizard.js";
import * as fs from "fs/promises";
import * as path from "path";

const program = new Command();

program
  .name("llm-shim")
  .description(
    `Lightweight OpenAI-compatible proxy for LM Studio with optional encryption, upload, and P2P transport.

MODES:
  Server mode (default): Accepts OpenAI-compatible HTTP requests and proxies them to a local LM Studio instance.
  Client mode (--client): Connects to a remote LLM Shim server via WebRTC or libp2p, exposing a local HTTP endpoint.

QUICK START:
  llm-shim                                          # Start server on port 8080, proxy to LM Studio at localhost:1234
  llm-shim --port 9000 --lmstudio-url http://gpu-box:1234
  llm-shim --client --shim-url http://192.168.1.50:8081  # Connect to remote shim via WebRTC
  llm-shim --client --libp2p --peerid 12D3KooW...        # Connect to remote shim via libp2p
  llm-shim configure                                     # Interactive guided setup wizard
  llm-shim --config ./my-config.json                     # Start with a saved config file

FOR AI AGENTS / AUTOMATED SETUP:
  1. Generate a config file:  llm-shim configure --non-interactive --output ./llm-shim.config.json
  2. Edit the JSON file to set your desired values (lmstudio.baseUrl, transport.port, etc.)
  3. Validate:               llm-shim config-show --config ./llm-shim.config.json --validate
  4. Start:                  llm-shim --config ./llm-shim.config.json
  For client mode:           llm-shim configure --non-interactive --mode client --output ./client.json

CONFIG PRIORITY: CLI flags > config file > interactive wizard > defaults`
  )
  .version("1.0.0")

  // ── Mode selection ──
  .option(
    "--client",
    "Run as a CLIENT that bridges to a remote LLM Shim server. " +
    "Creates a local HTTP proxy (on --port) that forwards requests over WebRTC or libp2p. " +
    "Requires --shim-url (WebRTC) or --peerid + --libp2p (libp2p). " +
    "Example: --client --shim-url http://192.168.1.50:8081",
    false
  )

  // ── Transport (server mode) ──
  .option(
    "--webrtc",
    "Use WebRTC DataChannel transport instead of plain HTTP (server mode). " +
    "Clients connect via signaling + SDP exchange. Mutually exclusive with --libp2p.",
    false
  )
  .option(
    "--port <number>",
    "Port number for the server (or local proxy in client mode). " +
    "In server mode: the port LLM clients connect to. " +
    "In client mode: the local port that exposes the proxied LLM API. " +
    "Example: --port 9000",
    "8080"
  )
  .option(
    "--host <address>",
    "Network bind address. Use 0.0.0.0 to listen on all interfaces, " +
    "or 127.0.0.1 for localhost only. Example: --host 127.0.0.1",
    "0.0.0.0"
  )

  // ── LM Studio connection (server mode) ──
  .option(
    "--lmstudio-url <url>",
    "Base URL of the LM Studio server to proxy requests to. " +
    "LM Studio must be running and serving its OpenAI-compatible API at this URL. " +
    "Example: --lmstudio-url http://gpu-server:1234",
    "http://localhost:1234"
  )
  .option(
    "--lmstudio-token <token>",
    "API bearer token for LM Studio authentication (if LM Studio requires one). " +
    "Optional — only needed if LM Studio is configured with API key auth."
  )
  .option(
    "--timeout <ms>",
    "Request timeout for LM Studio requests in milliseconds. " +
    "Set to 0 for no timeout (useful for long-running completions). " +
    "Example: --timeout 60000 (60 seconds)",
    "0"
  )
  .option(
    "--no-logger",
    "Disable the built-in request/response logger middleware. " +
    "By default, all requests are logged to stdout."
  )

  // ── Gzip middleware ──
  .option(
    "--gzip",
    "Enable gzip compression of LLM responses before sending to clients. " +
    "Reduces bandwidth usage. Combine with --gzip-level to control compression ratio.",
    false
  )
  .option(
    "--gzip-level <level>",
    "Gzip compression level from 0 (no compression, fastest) to 9 (max compression, slowest). " +
    "Only used when --gzip is enabled. Example: --gzip --gzip-level 9",
    "6"
  )

  // ── Encrypt middleware (TACo) ──
  .option(
    "--taco-encrypt",
    "Enable TACo threshold encryption for LLM responses. " +
    "Encrypts responses using NuCypher's TACo protocol with DAO-gated access control. " +
    "Requires --dao-contract. Example: --taco-encrypt --dao-contract 0xABC...",
    false
  )
  .option(
    "--taco-domain <domain>",
    "TACo network domain: 'lynx' (devnet), 'tapir' (testnet), or 'mainnet' (production). " +
    "Example: --taco-domain mainnet",
    "lynx"
  )
  .option(
    "--taco-ritual-id <id>",
    "TACo DKG ritual ID (positive integer). Identifies the key-sharing ceremony. " +
    "Example: --taco-ritual-id 42",
    "27"
  )
  .option(
    "--dao-contract <address>",
    "Ethereum contract address (0x...) of the DAO token used for access control. " +
    "Required when --taco-encrypt is enabled. Only holders with sufficient balance can decrypt."
  )
  .option(
    "--dao-chain <chain>",
    "Blockchain network for DAO token balance checks. " +
    "Example: 'sepolia', 'mainnet', 'polygon'. Must match where the DAO token is deployed.",
    "sepolia"
  )
  .option(
    "--dao-min-balance <balance>",
    "Minimum DAO token balance required to decrypt responses. " +
    "Example: --dao-min-balance 100",
    "1"
  )

  // ── Upload middleware (Synapse / Filecoin) ──
  .option(
    "--upload",
    "Enable automatic upload of LLM conversations to Filecoin via Synapse. " +
    "Conversations are batched, packed into CAR files, and stored on-chain. " +
    "Requires --synapse-private-key or HAVEN_PRIVATE_KEY env var.",
    false
  )
  .option(
    "--synapse-private-key <key>",
    "Ethereum private key (0x...) for signing Filecoin storage deals via Synapse. " +
    "Alternatively, set the HAVEN_PRIVATE_KEY environment variable."
  )
  .option(
    "--synapse-rpc-url <url>",
    "Filecoin JSON-RPC endpoint URL for Synapse storage transactions. " +
    "Example: --synapse-rpc-url https://api.node.glif.io/rpc/v1",
    "https://api.calibration.node.glif.io/rpc/v1"
  )
  .option(
    "--batch-size <size>",
    "Number of conversations to accumulate before uploading a batch to Filecoin. " +
    "Larger batches are more efficient but increase latency. Example: --batch-size 50",
    "100"
  )
  .option(
    "--registry-path <path>",
    "File path for the HAMT registry that tracks uploaded batches and CIDs. " +
    "Example: --registry-path ./my-registry.json",
    "./registry.json"
  )

  // ── Shared key ──
  .option(
    "--key-metadata <path>",
    "File path to persist TACo encryption key metadata across sessions. " +
    "Enables key reuse so subsequent sessions don't re-generate keys. " +
    "Example: --key-metadata ./key-metadata.json"
  )

  // ── CID recorder ──
  .option(
    "--cid-log <path>",
    "Directory for Parquet-format CID logs that record all uploaded content identifiers. " +
    "Example: --cid-log ./my-cid-logs"
  )

  // ── Libp2p transport ──
  .option(
    "--libp2p",
    "Use libp2p transport via IPFS p2p tunneling instead of plain HTTP. " +
    "Requires a running Kubo IPFS daemon with Libp2pStreamMounting enabled. " +
    "Mutually exclusive with --webrtc. In client mode, connects to remote peer via libp2p.",
    false
  )
  .option(
    "--libp2p-protocol <name>",
    "Libp2p protocol identifier for the tunnel. Must start with /x/. " +
    "Both server and client must use the same protocol name. " +
    "Example: --libp2p-protocol /x/myapp",
    "/x/llmshim"
  )
  .option(
    "--ipfs-api-url <url>",
    "URL of the Kubo IPFS daemon's HTTP RPC API (port 5001 by default). " +
    "Used for libp2p transport to manage p2p tunnels. " +
    "Example: --ipfs-api-url http://192.168.1.10:5001",
    "http://127.0.0.1:5001"
  )

  // ── Configuration file ──
  .option(
    "--config <path>",
    "Load configuration from a JSON file instead of using CLI flags. " +
    "CLI flags override config file values. If no --config is specified and no CLI flags " +
    "are provided, looks for ./llm-shim.config.json automatically. " +
    "Create one with: llm-shim configure"
  )

  // ── Client bridge options ──
  .option(
    "--shim-url <url>",
    "[Client mode] URL of the remote LLM Shim server's control/signaling endpoint. " +
    "Required for WebRTC client mode. The remote shim must be running with WebRTC transport. " +
    "Example: --client --shim-url http://192.168.1.50:8081"
  )
  .option(
    "--peerid <id>",
    "[Client mode] IPFS PeerID of the remote LLM Shim server (12D3KooW...). " +
    "Required for libp2p client mode. The remote shim must be running with libp2p transport. " +
    "Example: --client --libp2p --peerid 12D3KooWABC123..."
  )
  .option(
    "--client-host <address>",
    "[Client mode] Local bind address for the HTTP proxy that exposes the remote LLM API. " +
    "Clients on this machine send OpenAI requests to http://<client-host>:<port>. " +
    "Example: --client-host 0.0.0.0 (to expose on LAN)",
    "127.0.0.1"
  )
  .option(
    "--signaling-port <number>",
    "[Client mode, WebRTC] Port for the ephemeral signaling server used during WebRTC handshake. " +
    "Set to 0 for a random available port. Example: --signaling-port 9090",
    "0"
  )
  .option(
    "--client-timeout <ms>",
    "[Client mode] Timeout in milliseconds for LLM requests forwarded through the bridge. " +
    "Should be long enough for model inference. Example: --client-timeout 300000 (5 min)",
    "120000"
  );

// ── Parse options before action handlers ──
const opts = program.opts<{
  client: boolean;
  webrtc: boolean;
  port: string;
  host: string;
  lmstudioUrl: string;
  lmstudioToken?: string;
  timeout: string;
  logger: boolean;
  // Gzip
  gzip: boolean;
  gzipLevel: string;
  // Encrypt (TACo)
  tacoEncrypt: boolean;
  tacoDomain: string;
  tacoRitualId: string;
  daoContract?: string;
  daoChain: string;
  daoMinBalance: string;
  // Upload
  upload: boolean;
  synapsePrivateKey?: string;
  synapseRpcUrl: string;
  batchSize: string;
  registryPath: string;
  // Shared key
  keyMetadata?: string;
  // CID recorder
  cidLog?: string;
  // Libp2p
  libp2p: boolean;
  libp2pProtocol: string;
  ipfsApiUrl: string;
  // Config
  config?: string;
  // Client bridge
  shimUrl?: string;
  peerid?: string;
  clientHost: string;
  signalingPort: string;
  clientTimeout: string;
}>();

// ── Transport selection with mutual exclusivity ──
// HTTP is default, --webrtc or --libp2p override
const transportFlags = [(opts.webrtc ? 1 : 0), (opts.libp2p ? 1 : 0)].filter(Boolean);
if (transportFlags.length > 1) {
  console.error(
    "Error: Only one transport mode can be active. Choose --webrtc or --libp2p (HTTP is default)."
  );
  process.exit(1);
}

// Validate libp2p-specific flags
if (opts.libp2p) {
  if (!opts.libp2pProtocol.startsWith("/x/")) {
    console.error(
      "Error: --libp2p-protocol must start with /x/ (e.g., /x/llmshim)"
    );
    process.exit(1);
  }
}

let transport: "http" | "webrtc" | "libp2p";
if (opts.libp2p) {
  transport = "libp2p";
} else if (opts.webrtc) {
  transport = "webrtc";
} else {
  transport = "http";
}

// ── Default action - start the shim ──
program.action(() => {
  // Start the shim with parsed options
  main().catch((err) => {
    if (
      err instanceof IpfsDaemonNotRunningError ||
      err instanceof Libp2pStreamMountingDisabledError ||
      err instanceof P2PProtocolInUseError ||
      err instanceof PeerIDUnreachableError ||
      err instanceof IpfsApiUrlError
    ) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    console.error("[main] fatal error:", err);
    process.exit(1);
  });
});

// ── Export subcommand ──
const exportCmd = program.command("export")
  .description("Export conversations to LLaVA JSONL format")
  .requiredOption(
    "--registry <path>",
    "Path to HAMT registry file"
  )
  .option(
    "--batch <id>",
    "Batch ID to export (default: export all batches)"
  )
  .requiredOption(
    "--output <dir>",
    "Output directory for JSONL files"
  )
  .option(
    "--car-dir <dir>",
    "Directory containing CAR files (default: ./data)"
  )
  .option(
    "--extract-images",
    "Extract images from conversations (requires image URLs in content)",
    false
  )
  .action(exportCommand);

// ── Registry status subcommand ──
program.command("registry-status")
  .description("Show status of the HAMT registry")
  .requiredOption(
    "--registry <path>",
    "Path to HAMT registry file"
  )
  .option(
    "--verbose",
    "Show detailed information including all CIDs",
    false
  )
  .action(registryStatusCommand);

// ── Configure subcommand (guided wizard or non-interactive) ──
program.command("configure")
  .description(
    "Create or edit a configuration file. " +
    "Use --non-interactive to generate a default config JSON file that you can edit directly. " +
    "Without --non-interactive, launches an interactive guided wizard (requires a TTY)."
  )
  .option(
    "--output <path>",
    "Output path for the config file. " +
    "Example: llm-shim configure --output ./my-config.json",
    DEFAULT_CONFIG_PATH
  )
  .option(
    "--edit <path>",
    "Edit an existing config file (loads it as defaults for the wizard)"
  )
  .option(
    "--non-interactive",
    "Skip the interactive wizard and write a default config JSON file. " +
    "The generated file contains all settings with sensible defaults and comments. " +
    "Edit the JSON file directly, then start with: llm-shim --config <path>. " +
    "This is the recommended approach for AI agents and automated setups.",
    false
  )
  .option(
    "--mode <mode>",
    "Set the mode in the generated config: 'server' (default) or 'client'. " +
    "Only used with --non-interactive. Example: --non-interactive --mode client",
    "server"
  )
  .action(async (options: { output: string; edit?: string; nonInteractive: boolean; mode: string }) => {
    try {
      // ── Non-interactive mode: generate config file directly ──
      if (options.nonInteractive) {
        const config = createDefaultConfig();
        config.mode = options.mode as "server" | "client";
        config.description = `Generated by llm-shim configure --non-interactive on ${new Date().toISOString()}`;

        await writeConfigFile(config, options.output);

        const absPath = path.resolve(options.output);
        console.log(`[configure] ✓ Default configuration written to: ${absPath}`);
        console.log();
        console.log(`  To customize, edit the JSON file directly:`);
        console.log(`    ${absPath}`);
        console.log();
        console.log(`  Key fields to configure:`);
        if (config.mode === "server") {
          console.log(`    • lmstudio.baseUrl     – URL of your LM Studio instance (default: http://localhost:1234)`);
          console.log(`    • transport.port        – Port to listen on (default: 8080)`);
          console.log(`    • transport.host        – Bind address (default: 0.0.0.0)`);
          console.log(`    • middleware.gzip       – Enable gzip compression (default: false)`);
          console.log(`    • middleware.tacoEncrypt – Enable TACo encryption (default: false)`);
          console.log(`    • middleware.upload      – Enable Filecoin upload (default: false)`);
        } else {
          console.log(`    • clientBridge.transport   – "webrtc" or "libp2p"`);
          console.log(`    • clientBridge.shimUrl     – Remote shim URL (for WebRTC)`);
          console.log(`    • clientBridge.peerID      – Remote PeerID (for libp2p)`);
          console.log(`    • clientBridge.localHost   – Local bind address (default: 127.0.0.1)`);
          console.log(`    • transport.port           – Local proxy port (default: 8080)`);
        }
        console.log();
        console.log(`  Then start the shim with:`);
        console.log(`    llm-shim --config ${options.output}`);
        console.log();
        console.log(`  To validate your edits:`);
        console.log(`    llm-shim config-show --config ${options.output} --validate`);
        console.log();
        return;
      }

      // ── Interactive wizard mode ──
      let existingConfig: ShimConfig | undefined;

      if (options.edit) {
        // Edit mode: load existing config as defaults
        try {
          existingConfig = await readConfigFile(options.edit);
          console.log(`[configure] Loaded existing config from ${options.edit}`);
        } catch (error) {
          console.error(`[configure] ✗ Failed to load config: ${(error as Error).message}`);
          process.exit(1);
        }
      } else {
        // Check if default config exists and offer to edit it
        const defaultExists = await configFileExists(options.output);
        if (defaultExists) {
          try {
            existingConfig = await readConfigFile(options.output);
            console.log(`[configure] Found existing config at ${options.output}, loading as defaults.`);
          } catch {
            // Ignore, start fresh
          }
        }
      }

      await runConfigWizard(existingConfig, options.output);
    } catch (error) {
      console.error(`[configure] ✗ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// ── Config show subcommand ──
program.command("config-show")
  .description("Display the current configuration (from file or defaults)")
  .option(
    "--config <path>",
    "Path to config file to display",
    DEFAULT_CONFIG_PATH
  )
  .option(
    "--validate",
    "Run validation checks on the config",
    false
  )
  .option(
    "--json",
    "Output raw JSON instead of formatted display",
    false
  )
  .action(async (options: { config: string; validate: boolean; json: boolean }) => {
    try {
      const exists = await configFileExists(options.config);
      if (!exists) {
        console.error(`[config-show] ✗ Config file not found: ${options.config}`);
        console.error(`[config-show]   Run 'llm-shim configure' to create one.`);
        process.exit(1);
      }

      const config = await readConfigFile(options.config);

      if (options.json) {
        console.log(JSON.stringify(config, null, 2));
      } else {
        console.log(`[config-show] Loaded from: ${options.config}`);
        printConfig(config);
      }

      if (options.validate) {
        const validation = validateConfig(config);
        console.log("  ── Validation ──");
        console.log(`    Status: ${validation.valid ? "✓ Valid" : "✗ Invalid"}`);
        if (validation.errors.length > 0) {
          for (const err of validation.errors) {
            console.log(`    ✗ ${err}`);
          }
        }
        if (validation.warnings.length > 0) {
          for (const warn of validation.warnings) {
            console.log(`    ⚠ ${warn}`);
          }
        }
        console.log();
      }
    } catch (error) {
      console.error(`[config-show] ✗ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║         LLM Shim v1.0.0             ║");
  console.log("║   OpenAI → LM Studio Proxy          ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // ── Resolve configuration (CLI flags → config file → wizard → defaults) ──
  const cfg = await resolveConfig(opts as any, process.argv);

  // ── Client mode: delegate to client bridge ──
  if (cfg.mode === "client") {
    const bridge = await startClientBridge(cfg);

    const shutdown = async () => {
      console.log("\n[client] shutting down…");
      await bridge.shutdown();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  // ── Server mode ──

  // Create engine using resolved config
  const engine = new Engine({
    lmstudio: {
      baseUrl: cfg.lmstudio.baseUrl,
      apiToken: cfg.lmstudio.apiToken,
      timeoutMs: cfg.lmstudio.timeoutMs,
    },
  });

  // ── Register built-in middleware ──

  if (cfg.middleware.logger) {
    engine.use(loggerMiddleware);
  }

  // ── Gzip middleware ──

  if (cfg.middleware.gzip) {
    const level = cfg.middleware.gzipLevel;
    if (level < 0 || level > 9 || isNaN(level)) {
      console.error("[main] ✗ gzip level must be 0-9");
      process.exit(1);
    }
    engine.use(createGzipMiddleware({ level }));
    console.log(`[main] ✓ gzip middleware enabled (level=${level})`);
  }

  // ── Encrypt middleware (TACo) ──

  let tacoEncryptHandle: TacoEncryptMiddlewareHandle | null = null;

  if (cfg.middleware.tacoEncrypt) {
    if (!cfg.encryption.daoContract) {
      console.error(
        "[main] ✗ encryption.daoContract is required when taco-encrypt is enabled"
      );
      process.exit(1);
    }

    const ritualId = cfg.encryption.tacoRitualId;
    if (isNaN(ritualId) || ritualId <= 0) {
      console.error("[main] ✗ tacoRitualId must be a positive integer");
      process.exit(1);
    }

    // Private key for encryption/signing (config or env var)
    const privateKey =
      cfg.upload.synapsePrivateKey || process.env.HAVEN_PRIVATE_KEY;

    tacoEncryptHandle = createTacoEncryptMiddleware({
      tacoDomain: cfg.encryption.tacoDomain,
      ritualId,
      daoContractAddress: cfg.encryption.daoContract,
      daoChain: cfg.encryption.daoChain,
      minimumBalance: cfg.encryption.daoMinBalance,
      privateKey,
      keyMetadataPath: cfg.encryption.keyMetadataPath,
    });

    // Initialize TACo encryption
    console.log(
      `[main] initialising TACo encryption (domain=${cfg.encryption.tacoDomain}, ritualId=${ritualId}, daoContract=${cfg.encryption.daoContract})…`
    );
    await tacoEncryptHandle.initialize();

    engine.use(tacoEncryptHandle.middleware);
    console.log(
      `[main] ✓ taco-encrypt middleware enabled (domain=${cfg.encryption.tacoDomain}, ritualId=${ritualId})`
    );
  }

  // ── Upload middleware (Synapse / Filecoin) ──

  let synapseUploader: ReturnType<typeof createSynapseUploader> | null = null;
  let uploadHandle: UploadMiddlewareHandle | null = null;
  let cidRecorder: CidRecorderHandle | null = null;

  if (cfg.middleware.upload) {
    const privateKey =
      cfg.upload.synapsePrivateKey || process.env.HAVEN_PRIVATE_KEY;
    if (!privateKey) {
      console.error(
        "[main] ✗ upload.synapsePrivateKey or HAVEN_PRIVATE_KEY env is required when upload is enabled"
      );
      process.exit(1);
    }

    synapseUploader = createSynapseUploader({
      privateKey,
      rpcUrl: cfg.upload.synapseRpcUrl,
    });

    uploadHandle = createUploadMiddleware({
      synapseUpload: synapseUploader.upload,
      registryPath: cfg.upload.registryPath,
      batchSize: cfg.upload.batchSize,
      carDir: "./data",
    });
    engine.use(uploadHandle.middleware);
    console.log(
      `[main] ✓ upload middleware enabled (rpc=${cfg.upload.synapseRpcUrl}, batchSize=${cfg.upload.batchSize}, registry=${cfg.upload.registryPath})`
    );

    // Upload encryption session metadata once at startup (if encrypt is active).
    // In shared key mode, the metadataCid is persisted in the key metadata
    // file after the first upload so subsequent sessions skip re-uploading.
    let sessionMetadataCid: string | undefined;
    if (tacoEncryptHandle) {
      const fs = await import("fs");

      // Check if a previously uploaded metadataCid is already persisted
      if (cfg.encryption.keyMetadataPath && fs.existsSync(cfg.encryption.keyMetadataPath)) {
        try {
          const persisted = JSON.parse(
            fs.readFileSync(cfg.encryption.keyMetadataPath, "utf-8")
          );
          if (persisted.metadataCid) {
            sessionMetadataCid = persisted.metadataCid;
            console.log(
              `[main] ✓ reusing persisted metadata CID=${sessionMetadataCid} (shared key mode, skipping upload)`
            );
          }
        } catch { /* fall through to upload */ }
      }

      // Upload if we don't already have the CID
      if (!sessionMetadataCid) {
        const metaJson = JSON.stringify(
          tacoEncryptHandle.getSessionMetadata(),
          null,
          2
        );
        const os = await import("os");
        const path = await import("path");
        const metaFile = path.join(
          os.tmpdir(),
          `llm-shim-session-metadata.json`
        );
        fs.writeFileSync(metaFile, metaJson, "utf-8");

        try {
          console.log("[main] uploading session encryption metadata…");
          const metaResult = await synapseUploader.upload(metaFile);
          sessionMetadataCid = metaResult.cid;
          console.log(
            `[main] ✓ session metadata uploaded (CID=${sessionMetadataCid})`
          );

          // Persist the metadataCid into the key metadata file so future
          // sessions skip the upload entirely.
          if (cfg.encryption.keyMetadataPath && fs.existsSync(cfg.encryption.keyMetadataPath)) {
            try {
              const persisted = JSON.parse(
                fs.readFileSync(cfg.encryption.keyMetadataPath, "utf-8")
              );
              persisted.metadataCid = sessionMetadataCid;
              fs.writeFileSync(
                cfg.encryption.keyMetadataPath,
                JSON.stringify(persisted, null, 2),
                "utf-8"
              );
              console.log(
                `[main] ✓ metadataCid persisted to ${cfg.encryption.keyMetadataPath}`
              );
            } catch { /* non-fatal */ }
          }
        } finally {
          try { fs.unlinkSync(metaFile); } catch { /* ignore */ }
        }
      }
    }

    // CID recorder runs after upload — normalized Parquet layout
    const cidDir = cfg.cidRecorder.outputDir;
    cidRecorder = await createCidRecorder({
      outputDir: cidDir,
      sessionMetadataCid,
    });
    engine.use(cidRecorder.middleware);
    console.log(
      `[main] ✓ cid-recorder middleware enabled (dir=${cidDir}, session=${cidRecorder.sessionId})`
    );
  }

  // Check LM Studio connectivity
  const lmsOk = await engine.healthCheck();
  if (lmsOk) {
    console.log(`[main] ✓ LM Studio reachable at ${cfg.lmstudio.baseUrl}`);
  } else {
    console.warn(
      `[main] ✗ LM Studio not reachable at ${cfg.lmstudio.baseUrl} – requests will fail until it's available`
    );
  }

  // Start transport
  let libp2pTransport: { start: () => Promise<void>; shutdown: () => Promise<void> } | null = null;

  if (cfg.transport.mode === "libp2p") {
    console.log(`[main] starting libp2p transport...`);
    libp2pTransport = createLibp2pTransport(engine, {
      port: cfg.transport.port,
      protocol: cfg.libp2p.protocol,
      ipfsApiUrl: cfg.libp2p.ipfsApiUrl,
    });
    await libp2pTransport.start();
  } else if (cfg.transport.mode === "webrtc") {
    console.log(`[main] starting WebRTC transport...`);
    const webrtc = createWebRTCTransport(engine, {
      port: cfg.transport.port,
      host: cfg.transport.host,
    });
    await webrtc.start();
  } else {
    console.log(`[main] starting HTTP transport...`);
    const http = createHttpTransport(engine, {
      port: cfg.transport.port,
      host: cfg.transport.host,
    });
    await http.start();
  }

  console.log(`[main] shim is ready (transport=${cfg.transport.mode})`);

  // ── Graceful shutdown ──

  const shutdown = async () => {
    console.log("\n[main] shutting down…");

    // Drain any pending background upload flushes before exiting
    if (uploadHandle) {
      try {
        const stats = uploadHandle.getFlushStats();
        if (stats.pending > 0 || stats.activeJob) {
          console.log(`[main] draining ${stats.pending} pending flush(es)...`);
        }
        await uploadHandle.drainFlushes(30000);
        console.log("[main] upload flush queue drained");
      } catch { /* ignore */ }
    }

    if (tacoEncryptHandle) {
      tacoEncryptHandle.destroy();
      console.log("[main] taco-encrypt key material zeroed");
    }
    // Close libp2p tunnel (via HTTP RPC, not CLI)
    if (libp2pTransport) {
      await libp2pTransport.shutdown();
      console.log("[main] libp2p tunnel closed");
    }
    if (cidRecorder) {
      try {
        await cidRecorder.close();
      } catch { /* ignore */ }
    }
    if (synapseUploader) {
      try {
        await synapseUploader.cleanup();
        console.log("[main] Synapse cleaned up");
      } catch { /* ignore */ }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Export Command Implementation ────────────────────────────────────────────

interface ExportCommandOptions {
  registry: string;
  batch?: string;
  output: string;
  carDir?: string;
  extractImages: boolean;
}

async function exportCommand(options: ExportCommandOptions): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       LLaVA Exporter v1.0.0         ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  const { registry: registryPath, batch, output: outputDir, carDir = "./data", extractImages } = options;

  // Load registry
  console.log(`[export] Loading registry from ${registryPath}...`);
  const registry = createRegistry();
  try {
    await registry.load(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`[export] ✗ Registry file not found: ${registryPath}`);
      process.exit(1);
    }
    throw error;
  }

  const state = await registry.getState();
  console.log(`[export] Registry loaded: ${state.totalBatches} batches, ${state.totalConversations} conversations`);

  // Determine which batches to export
  let batchIds: number[] = [];
  if (batch !== undefined) {
    const batchId = parseInt(batch, 10);
    if (isNaN(batchId) || batchId < 0 || batchId >= state.totalBatches) {
      console.error(`[export] ✗ Invalid batch ID: ${batch}. Valid range: 0-${state.totalBatches - 1}`);
      process.exit(1);
    }
    batchIds = [batchId];
  } else {
    batchIds = state.batches.map((b: any) => b.batchId);
  }

  console.log(`[export] Exporting ${batchIds.length} batch(es)...`);

  let totalExported = 0;
  let totalErrors = 0;

  for (const batchId of batchIds) {
    const batchMetadata = state.batches[batchId];
    if (!batchMetadata) {
      console.warn(`[export] Skipping batch ${batchId}: not found`);
      continue;
    }

    console.log(`[export] Processing batch ${batchId} (${batchMetadata.conversationCount} conversations)...`);

    // Find CAR file for this batch
    // Format: batch directories with timestamp names containing merged.car
    let carPath: string | null = null;
    
    // First, check if carDir itself contains merged.car (direct batch directory)
    const directMergedCarPath = path.join(carDir, "merged.car");
    try {
      await fs.access(directMergedCarPath);
      carPath = directMergedCarPath;
    } catch {
      // Not a direct batch directory, search for batch subdirectories
    }
    
    // Search for batch directories with merged.car
    if (!carPath) {
      try {
        const batchDirs = await fs.readdir(carDir, { withFileTypes: true });
        for (const entry of batchDirs) {
          if (entry.isDirectory() && entry.name.startsWith(`batch-`)) {
            const mergedCarPath = path.join(carDir, entry.name, "merged.car");
            try {
              await fs.access(mergedCarPath);
              carPath = mergedCarPath;
              break;
            } catch {
              continue;
            }
          }
        }
      } catch {
        // carDir doesn't exist or isn't readable
      }
    }
    
    // Fall back to legacy format
    if (!carPath) {
      const legacyCarPath = path.join(carDir, `batch-${String(batchId).padStart(6, "0")}.car`);
      try {
        await fs.access(legacyCarPath);
        carPath = legacyCarPath;
      } catch {
        // File not found
      }
    }
    
    if (!carPath) {
      console.warn(`[export] CAR file not found for batch ${batchId}, skipping`);
      totalErrors++;
      continue;
    }

    // Export batch
    const result = await exportBatchFromCAR(
      carPath,
      outputDir,
      batchId
    );

    console.log(
      `[export] ✓ Batch ${batchId}: ${result.conversationCount} conversations exported to ${result.jsonlPath}`
    );

    if (result.errors.length > 0) {
      console.warn(`[export]   ${result.errors.length} errors during export`);
      totalErrors += result.errors.length;
    }

    totalExported += result.conversationCount;
  }

  console.log();
  console.log(`[export] Export complete: ${totalExported} conversations, ${totalErrors} errors`);
}

// ── Registry Status Command Implementation ──────────────────────────────────

interface RegistryStatusOptions {
  registry: string;
  verbose: boolean;
}

async function registryStatusCommand(options: RegistryStatusOptions): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       Registry Status v1.0.0        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  const { registry: registryPath, verbose } = options;

  // Load registry
  console.log(`[status] Loading registry from ${registryPath}...`);
  const registry = createRegistry();
  try {
    await registry.load(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`[status] ✗ Registry file not found: ${registryPath}`);
      process.exit(1);
    }
    throw error;
  }

  const state = await registry.getState();

  console.log(`[status] Registry Statistics:`);
  console.log(`  Version: ${state.version}`);
  console.log(`  Total Batches: ${state.totalBatches}`);
  console.log(`  Total Conversations: ${state.totalConversations}`);
  console.log(`  Last Updated: ${new Date(state.lastUpdated).toISOString()}`);
  console.log(`  Last Batch CID: ${state.lastBatchCid || "None"}`);
  console.log();

  if (verbose && state.batches.length > 0) {
    console.log(`[status] Batch Details:`);
    for (const batch of state.batches) {
      console.log(`  Batch ${batch.batchId}:`);
      console.log(`    Conversations: ${batch.conversationCount}`);
      console.log(`    CAR Size: ${batch.carSize} bytes`);
      console.log(`    Root CID: ${batch.rootCid || "N/A"}`);
      console.log(`    Filecoin CID: ${batch.filecoinCid || "Not uploaded"}`);
      console.log(`    Created: ${new Date(batch.createdAt).toISOString()}`);
      if (verbose) {
        console.log(`    CIDs:`);
        for (const cid of batch.conversationCids.slice(0, 10)) {
          console.log(`      - ${cid}`);
        }
        if (batch.conversationCids.length > 10) {
          console.log(`      ... and ${batch.conversationCids.length - 10} more`);
        }
      }
    }
  }
}

// Note: main() is now called via program.action() for the default command
// The subcommands (export, registry-status) have their own action handlers
