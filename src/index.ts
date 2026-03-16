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
  IpfsApiUrlError,
} from "./utils/ipfs-api.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { createGzipMiddleware } from "./middleware/gzip.js";
import {
  createTacoEncryptMiddleware,
  TacoEncryptMiddlewareHandle,
} from "./middleware/taco-encrypt.js";
import {
  createUploadMiddleware,
  createSynapseUploader,
} from "./middleware/upload.js";
import { createCidRecorder, CidRecorderHandle } from "./middleware/cid-recorder.js";
import {
  exportBatchFromCAR,
  LLaVAExporter,
  FileBlockStore,
} from "./export/llava-exporter.js";
import {
  createHAMTRegistry,
  createBatchProcessor,
  validateRegistry,
} from "./lib/registry.js";
import * as fs from "fs/promises";
import * as path from "path";

const program = new Command();

program
  .name("llm-shim")
  .description(
    "Lightweight shim that accepts OpenAI-compatible LLM requests and proxies to LM Studio"
  )
  .version("1.0.0")
  // ── Main command (transport options) ──
  // HTTP is the default transport - no flag needed
  .option("--webrtc", "Use WebRTC transport instead of HTTP", false)
  .option("--port <number>", "Port for the transport server", "8080")
  .option("--host <address>", "Bind address", "0.0.0.0")
  // ── LM Studio options ──
  .option(
    "--lmstudio-url <url>",
    "LM Studio base URL",
    "http://localhost:1234"
  )
  .option("--lmstudio-token <token>", "LM Studio API token")
  .option(
    "--timeout <ms>",
    "Request timeout to LM Studio in ms (0 = no timeout / infinite)",
    "0"
  )
  .option("--no-logger", "Disable built-in logger middleware")
  // ── Gzip middleware ──
  .option("--gzip", "Enable gzip compression of responses", false)
  .option(
    "--gzip-level <level>",
    "Gzip compression level (0-9)",
    "6"
  )
  // ── Encrypt middleware (TACo) ──
  .option("--taco-encrypt", "Enable TACo threshold encryption", false)
  .option(
    "--taco-domain <domain>",
    "TACo domain (e.g., lynx for DEVNET)",
    "lynx"
  )
  .option(
    "--taco-ritual-id <id>",
    "TACo ritual ID for DKG",
    "27"
  )
  .option(
    "--dao-contract <address>",
    "DAO token contract address for access control"
  )
  .option(
    "--dao-chain <chain>",
    "Blockchain chain for DAO token checks",
    "sepolia"
  )
  .option(
    "--dao-min-balance <balance>",
    "Minimum token balance required for access",
    "1"
  )
  // ── Upload middleware (Synapse / Filecoin) ──
  .option("--upload", "Enable Synapse upload to Filecoin", false)
  .option(
    "--synapse-private-key <key>",
    "Private key for Synapse/Filecoin transactions (or set HAVEN_PRIVATE_KEY env)"
  )
  .option(
    "--synapse-rpc-url <url>",
    "Filecoin RPC WebSocket URL",
    "https://api.calibration.node.glif.io/rpc/v1"
  )
  .option(
    "--batch-size <size>",
    "Batch size for LLaVA export (default: 100)",
    "100"
  )
  .option(
    "--registry-path <path>",
    "Path to HAMT registry file",
    "./registry.json"
  )
  // ── Shared key ──
  .option(
    "--key-metadata <path>",
    "Path to persist encryption key metadata JSON (enables shared key across sessions)"
  )
  // ── CID recorder ──
  .option(
    "--cid-log <path>",
    "Directory for Parquet CID logs (default: ./cids)"
  )
  // ── Libp2p transport options ──
  .option("--libp2p", "Use libp2p transport (IPFS p2p tunnel)", false)
  .option(
    "--libp2p-protocol <name>",
    "Libp2p protocol name for the tunnel",
    "/x/llmshim"
  )
  .option(
    "--ipfs-api-url <url>",
    "Kubo IPFS daemon HTTP RPC API URL",
    "http://127.0.0.1:5001"
  );

// ── Parse options before action handlers ──
const opts = program.opts<{
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

program.parse(process.argv);

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║         LLM Shim v1.0.0             ║");
  console.log("║   OpenAI → LM Studio Proxy          ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // Create engine
  const engine = new Engine({
    lmstudio: {
      baseUrl: opts.lmstudioUrl,
      apiToken: opts.lmstudioToken,
      timeoutMs: parseInt(opts.timeout, 10),
    },
  });

  // ── Register built-in middleware ──

  if (opts.logger !== false) {
    engine.use(loggerMiddleware);
  }

  // ── Gzip middleware ──

  if (opts.gzip) {
    const level = parseInt(opts.gzipLevel, 10);
    if (level < 0 || level > 9 || isNaN(level)) {
      console.error("[main] ✗ --gzip-level must be 0-9");
      process.exit(1);
    }
    engine.use(createGzipMiddleware({ level }));
    console.log(`[main] ✓ gzip middleware enabled (level=${level})`);
  }

  // ── Encrypt middleware (TACo) ──

  let tacoEncryptHandle: TacoEncryptMiddlewareHandle | null = null;

  if (opts.tacoEncrypt) {
    if (!opts.daoContract) {
      console.error(
        "[main] ✗ --dao-contract is required when --taco-encrypt is enabled"
      );
      process.exit(1);
    }

    const ritualId = parseInt(opts.tacoRitualId, 10);
    if (isNaN(ritualId) || ritualId <= 0) {
      console.error("[main] ✗ --taco-ritual-id must be a positive integer");
      process.exit(1);
    }

    // Private key for encryption/signing (same as Synapse key or env var)
    const privateKey =
      opts.synapsePrivateKey || process.env.HAVEN_PRIVATE_KEY;

    tacoEncryptHandle = createTacoEncryptMiddleware({
      tacoDomain: opts.tacoDomain,
      ritualId,
      daoContractAddress: opts.daoContract,
      daoChain: opts.daoChain,
      minimumBalance: opts.daoMinBalance,
      privateKey,
      keyMetadataPath: opts.keyMetadata,
    });

    // Initialize TACo encryption
    console.log(
      `[main] initialising TACo encryption (domain=${opts.tacoDomain}, ritualId=${ritualId}, daoContract=${opts.daoContract})…`
    );
    await tacoEncryptHandle.initialize();

    engine.use(tacoEncryptHandle.middleware);
    console.log(
      `[main] ✓ taco-encrypt middleware enabled (domain=${opts.tacoDomain}, ritualId=${ritualId})`
    );
  }

  // ── Upload middleware (Synapse / Filecoin) ──

  let synapseUploader: ReturnType<typeof createSynapseUploader> | null = null;
  let cidRecorder: CidRecorderHandle | null = null;

  if (opts.upload) {
    const privateKey =
      opts.synapsePrivateKey || process.env.HAVEN_PRIVATE_KEY;
    if (!privateKey) {
      console.error(
        "[main] ✗ --synapse-private-key or HAVEN_PRIVATE_KEY env is required when --upload is enabled"
      );
      process.exit(1);
    }

    synapseUploader = createSynapseUploader({
      privateKey,
      rpcUrl: opts.synapseRpcUrl,
    });

    engine.use(
      createUploadMiddleware({
        synapseUpload: synapseUploader.upload,
        registryPath: opts.registryPath,
        batchSize: parseInt(opts.batchSize, 10),
        batchBeforeUpload: true,
        carDir: "./data",
      })
    );
    console.log(
      `[main] ✓ upload middleware enabled (rpc=${opts.synapseRpcUrl}, batchSize=${opts.batchSize}, registry=${opts.registryPath})`
    );

    // Upload encryption session metadata once at startup (if encrypt is active).
    // In shared key mode, the metadataCid is persisted in the key metadata
    // file after the first upload so subsequent sessions skip re-uploading.
    let sessionMetadataCid: string | undefined;
    if (tacoEncryptHandle) {
      const fs = await import("fs");

      // Check if a previously uploaded metadataCid is already persisted
      if (opts.keyMetadata && fs.existsSync(opts.keyMetadata)) {
        try {
          const persisted = JSON.parse(
            fs.readFileSync(opts.keyMetadata, "utf-8")
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
          if (opts.keyMetadata && fs.existsSync(opts.keyMetadata)) {
            try {
              const persisted = JSON.parse(
                fs.readFileSync(opts.keyMetadata, "utf-8")
              );
              persisted.metadataCid = sessionMetadataCid;
              fs.writeFileSync(
                opts.keyMetadata,
                JSON.stringify(persisted, null, 2),
                "utf-8"
              );
              console.log(
                `[main] ✓ metadataCid persisted to ${opts.keyMetadata}`
              );
            } catch { /* non-fatal */ }
          }
        } finally {
          try { fs.unlinkSync(metaFile); } catch { /* ignore */ }
        }
      }
    }

    // CID recorder runs after upload — normalized Parquet layout
    const cidDir = opts.cidLog ?? "cids";
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
    console.log(`[main] ✓ LM Studio reachable at ${opts.lmstudioUrl}`);
  } else {
    console.warn(
      `[main] ✗ LM Studio not reachable at ${opts.lmstudioUrl} – requests will fail until it's available`
    );
  }

  // Start transport
  let libp2pTransport: { start: () => Promise<void>; shutdown: () => Promise<void> } | null = null;

  if (transport === "libp2p") {
    console.log(`[main] starting libp2p transport...`);
    libp2pTransport = createLibp2pTransport(engine, {
      port: parseInt(opts.port, 10),
      protocol: opts.libp2pProtocol,
      ipfsApiUrl: opts.ipfsApiUrl,
    });
    await libp2pTransport.start();
  } else if (transport === "webrtc") {
    console.log(`[main] starting WebRTC transport...`);
    const webrtc = createWebRTCTransport(engine, {
      port: parseInt(opts.port, 10),
      host: opts.host,
    });
    await webrtc.start();
  } else {
    console.log(`[main] starting HTTP transport...`);
    const http = createHttpTransport(engine, {
      port: parseInt(opts.port, 10),
      host: opts.host,
    });
    await http.start();
  }

  console.log(`[main] shim is ready (transport=${transport})`);

  // ── Graceful shutdown ──

  const shutdown = async () => {
    console.log("\n[main] shutting down…");
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
  const registry = createHAMTRegistry();
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
    batchIds = state.batches.map((b) => b.batchId);
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
      batchMetadata.conversationCids,
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
  const registry = createHAMTRegistry();
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
  const validation = await validateRegistry(registry);

  console.log(`[status] Registry Statistics:`);
  console.log(`  Version: ${state.version}`);
  console.log(`  Total Batches: ${state.totalBatches}`);
  console.log(`  Total Conversations: ${state.totalConversations}`);
  console.log(`  Last Updated: ${new Date(state.lastUpdated).toISOString()}`);
  console.log(`  HAMT Root: ${state.hamtRoot || "Not built"}`);
  console.log();

  console.log(`[status] Validation:`);
  console.log(`  Status: ${validation.valid ? "✓ Valid" : "✗ Invalid"}`);
  if (validation.errors.length > 0) {
    console.log(`  Errors:`);
    for (const error of validation.errors) {
      console.log(`    - ${error}`);
    }
  }
  if (validation.warnings.length > 0) {
    console.log(`  Warnings:`);
    for (const warning of validation.warnings) {
      console.log(`    - ${warning}`);
    }
  }
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
