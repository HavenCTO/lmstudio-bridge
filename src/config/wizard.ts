/**
 * Interactive guided configuration wizard.
 *
 * Walks the admin through a series of questions to build a ShimConfig,
 * then saves it to a config file. Uses Node.js readline for zero
 * additional dependencies.
 *
 * Usage:
 *   llm-shim configure              # Create new config (or edit existing)
 *   llm-shim configure --output ./my-config.json
 */

import * as readline from "readline";
import { ShimConfig, createDefaultConfig } from "./types.js";
import {
  writeConfigFile,
  validateConfig,
  printConfig,
  DEFAULT_CONFIG_PATH,
} from "./config-file.js";

// ── Chain name to ID mapping ──
const CHAIN_ID_MAP: Record<string, number> = {
  'mainnet': 1,
  'ethereum': 1,
  'sepolia': 11155111,
  'goerli': 5,
  'polygon': 137,
  'matic': 137,
  'amoy': 80002,
  'mumbai': 80001,
  'optimism': 10,
  'arbitrum': 42161,
  'base': 8453,
  'bsc': 56,
  'binance': 56,
  'avalanche': 43114,
  'fantom': 250,
};

/**
 * Convert a chain name or ID string to a numeric chain ID.
 * Supports both named chains (e.g., "sepolia") and numeric IDs (e.g., "11155111").
 */
function parseChainId(input: string): number {
  const trimmed = input.trim().toLowerCase();
  
  // Try parsing as number first
  const numericId = parseInt(trimmed, 10);
  if (!isNaN(numericId)) {
    return numericId;
  }
  
  // Look up in chain name map
  if (CHAIN_ID_MAP[trimmed]) {
    return CHAIN_ID_MAP[trimmed];
  }
  
  // Default to Sepolia if unknown
  console.warn(`  ⚠ Unknown chain "${input}", defaulting to Sepolia (11155111)`);
  return 11155111;
}

/**
 * Create a readline interface for interactive prompts.
 */
function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt the user with a question and return their answer.
 * If a default is provided and the user presses Enter, the default is used.
 */
function ask(
  rl: readline.Interface,
  question: string,
  defaultValue?: string
): Promise<string> {
  const prompt = defaultValue !== undefined
    ? `${question} [${defaultValue}]: `
    : `${question}: `;

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

/**
 * Prompt the user with a yes/no question.
 */
async function askYesNo(
  rl: readline.Interface,
  question: string,
  defaultValue: boolean = false
): Promise<boolean> {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = await ask(rl, `${question} (${hint})`, defaultValue ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}

/**
 * Prompt the user to choose from a list of options.
 */
async function askChoice<T extends string>(
  rl: readline.Interface,
  question: string,
  choices: { value: T; label: string }[],
  defaultValue: T
): Promise<T> {
  console.log();
  console.log(`  ${question}`);
  for (let i = 0; i < choices.length; i++) {
    const marker = choices[i].value === defaultValue ? " (default)" : "";
    console.log(`    ${i + 1}) ${choices[i].label}${marker}`);
  }

  const defaultIndex = choices.findIndex((c) => c.value === defaultValue) + 1;
  const answer = await ask(rl, `  Enter choice (1-${choices.length})`, String(defaultIndex));
  const index = parseInt(answer, 10) - 1;

  if (index >= 0 && index < choices.length) {
    return choices[index].value;
  }
  return defaultValue;
}

/**
 * Prompt the user for a number within a range.
 */
async function askNumber(
  rl: readline.Interface,
  question: string,
  defaultValue: number,
  min?: number,
  max?: number
): Promise<number> {
  const rangeHint = min !== undefined && max !== undefined
    ? ` (${min}-${max})`
    : min !== undefined
      ? ` (>= ${min})`
      : "";

  const answer = await ask(rl, `${question}${rangeHint}`, String(defaultValue));
  const num = parseInt(answer, 10);

  if (isNaN(num)) return defaultValue;
  if (min !== undefined && num < min) return min;
  if (max !== undefined && num > max) return max;
  return num;
}

/**
 * Run the guided configuration wizard.
 *
 * @param existingConfig - If provided, use as defaults (edit mode)
 * @param outputPath - Where to save the config file
 * @returns The created/edited ShimConfig
 */
export async function runConfigWizard(
  existingConfig?: ShimConfig,
  outputPath: string = DEFAULT_CONFIG_PATH
): Promise<ShimConfig> {
  const rl = createRL();
  const config = existingConfig
    ? { ...JSON.parse(JSON.stringify(existingConfig)) } as ShimConfig
    : createDefaultConfig();

  try {
    console.log();
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║     LLM Shim Configuration Wizard            ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log();

    if (existingConfig) {
      console.log("  Editing existing configuration. Press Enter to keep current values.");
      console.log();
    } else {
      console.log("  This wizard will guide you through configuring the LLM Shim middleware.");
      console.log("  Press Enter to accept default values shown in [brackets].");
      console.log();
    }

    // ── Step 1: Mode ──
    console.log("━━━ Mode ━━━");
    config.mode = await askChoice(rl, "How should this instance run?", [
      { value: "server" as const, label: "Server – proxy OpenAI requests to LM Studio (default)" },
      { value: "client" as const, label: "Client – bridge to a remote LLM Shim server" },
    ], config.mode);

    // ── Step 2: Description ──
    console.log();
    console.log("━━━ General ━━━");
    config.description = await ask(
      rl,
      "  Configuration description (optional)",
      config.description || ""
    );

    // ── Client mode path ──
    if (config.mode === "client") {
      console.log();
      console.log("━━━ Client Bridge ━━━");
      config.clientBridge.transport = await askChoice(rl, "Client transport:", [
        { value: "webrtc" as const, label: "WebRTC (DataChannel to remote shim)" },
        { value: "libp2p" as const, label: "Libp2p (IPFS P2P tunnel to remote shim)" },
      ], config.clientBridge.transport);

      if (config.clientBridge.transport === "webrtc") {
        config.clientBridge.shimUrl = await ask(
          rl,
          "  Remote shim control URL (e.g., http://192.168.1.100:8081)",
          config.clientBridge.shimUrl || ""
        );
        config.clientBridge.signalingPort = await askNumber(
          rl,
          "  Signaling server port (0 = random)",
          config.clientBridge.signalingPort,
          0,
          65535
        );
      } else {
        config.clientBridge.peerID = await ask(
          rl,
          "  Remote shim PeerID (12D3KooW...)",
          config.clientBridge.peerID || ""
        );
      }

      config.clientBridge.localHost = await ask(
        rl,
        "  Local bind address for the proxy",
        config.clientBridge.localHost
      );

      config.transport.port = await askNumber(
        rl,
        "  Local proxy port",
        config.transport.port,
        1,
        65535
      );

      config.clientBridge.timeoutMs = await askNumber(
        rl,
        "  Request timeout in ms",
        config.clientBridge.timeoutMs,
        0
      );

      // Libp2p settings for client
      if (config.clientBridge.transport === "libp2p") {
        console.log();
        console.log("━━━ Libp2p Settings ━━━");
        config.libp2p.protocol = await ask(
          rl,
          "  Libp2p protocol name (must start with /x/)",
          config.libp2p.protocol
        );
        config.libp2p.ipfsApiUrl = await ask(
          rl,
          "  IPFS daemon HTTP RPC API URL",
          config.libp2p.ipfsApiUrl
        );
      }

      // Skip to review for client mode (no server-specific settings needed)
    } else {

    // ── Server mode path ──

    // ── Step 3: Transport ──
    console.log();
    console.log("━━━ Transport ━━━");
    config.transport.mode = await askChoice(rl, "Which transport mode?", [
      { value: "http", label: "HTTP (default, simple direct proxy)" },
      { value: "webrtc", label: "WebRTC (tunneled via client bridge)" },
      { value: "libp2p", label: "Libp2p (IPFS P2P tunnel)" },
    ], config.transport.mode);

    config.transport.port = await askNumber(
      rl,
      "  Server port",
      config.transport.port,
      1,
      65535
    );

    config.transport.host = await ask(
      rl,
      "  Bind address",
      config.transport.host
    );

    // Libp2p-specific settings
    if (config.transport.mode === "libp2p") {
      console.log();
      console.log("━━━ Libp2p Settings ━━━");
      config.libp2p.protocol = await ask(
        rl,
        "  Libp2p protocol name (must start with /x/)",
        config.libp2p.protocol
      );
      config.libp2p.ipfsApiUrl = await ask(
        rl,
        "  IPFS daemon HTTP RPC API URL",
        config.libp2p.ipfsApiUrl
      );
    }

    // ── Step 3: LM Studio ──
    console.log();
    console.log("━━━ LM Studio Connection ━━━");
    config.lmstudio.baseUrl = await ask(
      rl,
      "  LM Studio base URL",
      config.lmstudio.baseUrl
    );

    const hasToken = await askYesNo(
      rl,
      "  Does your LM Studio require an API token?",
      !!config.lmstudio.apiToken
    );
    if (hasToken) {
      config.lmstudio.apiToken = await ask(
        rl,
        "  LM Studio API token",
        config.lmstudio.apiToken || ""
      );
    } else {
      config.lmstudio.apiToken = undefined;
    }

    config.lmstudio.timeoutMs = await askNumber(
      rl,
      "  Request timeout in ms (0 = no timeout)",
      config.lmstudio.timeoutMs,
      0
    );

    // ── Step 4: Middleware Pipeline ──
    console.log();
    console.log("━━━ Middleware Pipeline ━━━");
    console.log("  The middleware pipeline processes requests/responses in order:");
    console.log("  logger → gzip → taco-encrypt → upload");
    console.log();

    config.middleware.logger = await askYesNo(
      rl,
      "  Enable request/response logger?",
      config.middleware.logger
    );

    // Gzip
    config.middleware.gzip = await askYesNo(
      rl,
      "  Enable gzip compression?",
      config.middleware.gzip
    );
    if (config.middleware.gzip) {
      config.middleware.gzipLevel = await askNumber(
        rl,
        "    Gzip compression level",
        config.middleware.gzipLevel,
        0,
        9
      );
    }

    // TACo Encryption
    config.middleware.tacoEncrypt = await askYesNo(
      rl,
      "  Enable TACo threshold encryption?",
      config.middleware.tacoEncrypt
    );
    if (config.middleware.tacoEncrypt) {
      console.log();
      console.log("  ── TACo Encryption Settings ──");
      config.encryption.tacoDomain = await askChoice(rl, "TACo domain:", [
        { value: "lynx", label: "lynx (DEVNET)" },
        { value: "tapir", label: "tapir (TESTNET)" },
        { value: "mainnet", label: "mainnet (PRODUCTION)" },
      ], config.encryption.tacoDomain as any);

      config.encryption.tacoRitualId = await askNumber(
        rl,
        "    TACo ritual ID",
        config.encryption.tacoRitualId,
        1
      );

      config.encryption.daoContract = await ask(
        rl,
        "    DAO token contract address (0x...)",
        config.encryption.daoContract || ""
      );

      const daoChainInput = await ask(
        rl,
        "    Blockchain chain for DAO checks (name or chain ID)",
        String(config.encryption.daoChain)
      );
      config.encryption.daoChain = parseChainId(daoChainInput);

      config.encryption.daoMinBalance = await ask(
        rl,
        "    Minimum token balance for access",
        config.encryption.daoMinBalance
      );

      const hasKeyMeta = await askYesNo(
        rl,
        "    Persist encryption key metadata across sessions?",
        !!config.encryption.keyMetadataPath
      );
      if (hasKeyMeta) {
        config.encryption.keyMetadataPath = await ask(
          rl,
          "    Key metadata file path",
          config.encryption.keyMetadataPath || "./key-metadata.json"
        );
      } else {
        config.encryption.keyMetadataPath = undefined;
      }
    }

    // Upload
    config.middleware.upload = await askYesNo(
      rl,
      "  Enable Synapse upload to Filecoin?",
      config.middleware.upload
    );
    if (config.middleware.upload) {
      console.log();
      console.log("  ── Upload Settings ──");

      const useEnvKey = await askYesNo(
        rl,
        "    Use HAVEN_PRIVATE_KEY environment variable for Synapse key?",
        !config.upload.synapsePrivateKey
      );
      if (!useEnvKey) {
        config.upload.synapsePrivateKey = await ask(
          rl,
          "    Synapse private key (0x...)",
          config.upload.synapsePrivateKey || ""
        );
      } else {
        config.upload.synapsePrivateKey = undefined;
      }

      config.upload.synapseRpcUrl = await ask(
        rl,
        "    Filecoin RPC URL",
        config.upload.synapseRpcUrl
      );

      config.upload.batchSize = await askNumber(
        rl,
        "    Batch size for LLaVA export",
        config.upload.batchSize,
        1
      );

      config.upload.registryPath = await ask(
        rl,
        "    HAMT registry file path",
        config.upload.registryPath
      );
    }

    // CID Recorder
    if (config.middleware.upload) {
      console.log();
      console.log("  ── CID Recorder ──");
      config.cidRecorder.outputDir = await ask(
        rl,
        "    CID log output directory",
        config.cidRecorder.outputDir
      );
    }

    } // end server mode else block

    // ── Review & Save ──
    console.log();
    console.log("━━━ Configuration Review ━━━");
    printConfig(config);

    // Validate
    const validation = validateConfig(config);
    if (!validation.valid) {
      console.log("  ⚠ Validation Errors:");
      for (const err of validation.errors) {
        console.log(`    ✗ ${err}`);
      }
      console.log();
    }
    if (validation.warnings.length > 0) {
      console.log("  ⚠ Warnings:");
      for (const warn of validation.warnings) {
        console.log(`    ⚠ ${warn}`);
      }
      console.log();
    }

    const saveIt = await askYesNo(
      rl,
      `  Save configuration to ${outputPath}?`,
      true
    );

    if (saveIt) {
      await writeConfigFile(config, outputPath);
      console.log();
      console.log(`  ✓ Configuration saved to ${outputPath}`);
      console.log();
      console.log(`  To start the shim with this config:`);
      console.log(`    llm-shim --config ${outputPath}`);
      console.log();
    } else {
      console.log();
      console.log("  Configuration not saved.");
      console.log();
    }

    return config;
  } finally {
    rl.close();
  }
}
