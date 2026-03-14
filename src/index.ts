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
 * Optional middleware pipeline (applied in order: gzip → encrypt → upload):
 *   llm-shim --gzip                              # Compress responses
 *   llm-shim --gzip --gzip-level 9               # Max compression
 *   llm-shim --encrypt --wallet-address 0x...     # Lit Protocol encryption
 *   llm-shim --encrypt --lit-network datil-dev    # Lit testnet
 *   llm-shim --upload --synapse-private-key 0x... # Filecoin upload via Synapse
 *   llm-shim --gzip --encrypt --upload            # Full pipeline
 */

import { Command } from "commander";
import { Engine } from "./pipeline/engine";
import { createHttpTransport } from "./transport/http";
import { createWebRTCTransport } from "./transport/webrtc";
import { createLibp2pTransport } from "./transport/libp2p";
import {
  IpfsDaemonNotRunningError,
  Libp2pStreamMountingDisabledError,
  P2PProtocolInUseError,
  IpfsApiUrlError,
} from "./utils/ipfs-api";
import { loggerMiddleware } from "./middleware/logger";
import { createGzipMiddleware } from "./middleware/gzip";
import {
  createEncryptMiddleware,
  createLitKeyEncryptor,
  EncryptMiddlewareHandle,
} from "./middleware/encrypt";
import {
  createTacoEncryptMiddleware,
  TacoEncryptMiddlewareHandle,
} from "./middleware/taco-encrypt";
import {
  createUploadMiddleware,
  createSynapseUploader,
} from "./middleware/upload";
import { createCidRecorder, CidRecorderHandle } from "./middleware/cid-recorder";

const program = new Command();

program
  .name("llm-shim")
  .description(
    "Lightweight shim that accepts OpenAI-compatible LLM requests and proxies to LM Studio"
  )
  .version("1.0.0")
  // ── Transport options ──
  .option("--http", "Use HTTP transport (default)", false)
  .option("--webrtc", "Use WebRTC transport", false)
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
  // ── Encrypt middleware (Lit Protocol) ──
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
  )
  .parse(process.argv);

const opts = program.opts<{
  http: boolean;
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
  // Encrypt (Lit)
  encrypt: boolean;
  litNetwork: string;
  walletAddress?: string;
  litChain: string;
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
const transportFlags = [opts.http, opts.webrtc, opts.libp2p].filter(Boolean);
if (transportFlags.length > 1) {
  console.error(
    "Error: Only one transport mode can be active. Choose --http, --webrtc, or --libp2p."
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

  // ── Encrypt middleware (Lit Protocol) ──

  // Track Lit key encryptor and encrypt handle for cleanup on shutdown
  let litKeyEncryptor: ReturnType<typeof createLitKeyEncryptor> | null = null;
  let encryptHandle: EncryptMiddlewareHandle | null = null;

  if (opts.encrypt) {
    if (!opts.walletAddress) {
      console.error(
        "[main] ✗ --wallet-address is required when --encrypt is enabled"
      );
      process.exit(1);
    }

    // The wallet private key is needed for Lit session signatures when
    // recovering a persisted key (shared key mode).
    const litPrivateKey =
      opts.synapsePrivateKey || process.env.HAVEN_PRIVATE_KEY;

    litKeyEncryptor = createLitKeyEncryptor({
      network: opts.litNetwork,
      privateKey: litPrivateKey,
      chain: opts.litChain,
    });

    encryptHandle = createEncryptMiddleware({
      litEncryptKey: litKeyEncryptor.encrypt,
      litDecryptKey: litPrivateKey ? litKeyEncryptor.decrypt : undefined,
      walletAddress: opts.walletAddress,
      chain: opts.litChain,
      keyMetadataPath: opts.keyMetadata,
    });

    // Generate AES key and wrap it via Lit once at startup
    console.log(
      `[main] initialising Lit Protocol encryption (network=${opts.litNetwork}, chain=${opts.litChain})…`
    );
    await encryptHandle.initialize();

    engine.use(encryptHandle.middleware);
    console.log(
      `[main] ✓ encrypt middleware enabled (network=${opts.litNetwork}, chain=${opts.litChain})`
    );
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
      })
    );
    console.log(
      `[main] ✓ upload middleware enabled (rpc=${opts.synapseRpcUrl})`
    );

    // Upload encryption session metadata once at startup (if encrypt is active).
    // In shared key mode, the metadataCid is persisted in the key metadata
    // file after the first upload so subsequent sessions skip re-uploading.
    let sessionMetadataCid: string | undefined;
    if (encryptHandle) {
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
          encryptHandle.getSessionMetadata(),
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
    if (encryptHandle) {
      encryptHandle.destroy();
      console.log("[main] encrypt key material zeroed");
    }
    if (tacoEncryptHandle) {
      tacoEncryptHandle.destroy();
      console.log("[main] taco-encrypt key material zeroed");
    }
    if (litKeyEncryptor) {
      try {
        await litKeyEncryptor.disconnect();
        console.log("[main] Lit Protocol disconnected");
      } catch { /* ignore */ }
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

main().catch((err) => {
  // Known libp2p errors — print clean message without stack trace
  if (
    err instanceof IpfsDaemonNotRunningError ||
    err instanceof Libp2pStreamMountingDisabledError ||
    err instanceof P2PProtocolInUseError ||
    err instanceof IpfsApiUrlError
  ) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  // Unknown error — print with stack trace
  console.error("[main] fatal error:", err);
  process.exit(1);
});
