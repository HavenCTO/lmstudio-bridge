/**
 * CLI Entry Point for LM Studio Bridge Data Recovery
 *
 * Usage:
 *   lmbridge-recover recover <CID> [options]    Recover a single conversation
 *   lmbridge-recover recover-all [options]      Recover all CIDs from metadata
 *   lmbridge-recover list [options]             List available CIDs
 *   lmbridge-recover decrypt <CID> [options]    Decrypt encrypted data
 *   lmbridge-recover extract <CAR-file>         Extract from local CAR file
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  recoverConversation,
  recoverConversations,
  listAvailableCids,
  EncryptedPayloadRecoveryOptions,
} from "./lib/recovery";
import { TacoDecryptionOptions } from "./lib/decryptor";
import { loadLocalCarFile, parseCarFile, extractConversation } from "./lib/car-extractor";

const program = new Command();

program
  .name("lmbridge-recover")
  .description("LM Studio Bridge Data Recovery Tool")
  .version("1.0.0");

// ── Recover Command ─────────────────────────────────────────────────────────

program
  .command("recover <cid>")
  .description("Recover a single conversation from IPFS by CID")
  .option("-g, --gateway <url>", "IPFS gateway URL", "https://ipfs.io")
  .option("-o, --output <dir>", "Output directory", "./recovered")
  .option("--skip-decryption", "Skip decryption even if data is encrypted")
  .option("--tacO-domain <domain>", "TACo domain (e.g., lynx, ursula)")
  .option("--tacO-ritual-id <id>", "TACo ritual ID", "27")
  .option("--tacO-private-key <key>", "TACo private key for authentication")
  .option("--rpc-url <url>", "Blockchain RPC URL")
  .option("--save-car", "Save raw CAR files to output directory")
  .option("--verbose", "Enable verbose logging")
  .action(async (cid, options) => {
    console.log("\n🔧 LM Studio Bridge Data Recovery\n");
    console.log(`CID: ${cid}`);
    console.log(`Gateway: ${options.gateway}`);
    console.log(`Output: ${options.output}\n`);

    // Prepare TACo options if encryption might be needed
    const tacoOptions: TacoDecryptionOptions | undefined =
      options.tacoDomain || options.tacoRitualId || options.tacoPrivateKey || options.rpcUrl
        ? {
            domain: options.tacoDomain || "lynx",
            ritualId: parseInt(options.tacoRitualId, 10),
            privateKey: options.tacoPrivateKey,
            rpcUrl: options.rpcUrl,
          }
        : undefined;

    const result = await recoverConversation(
      { type: "cid", cid },
      {
        outputDir: options.output,
        ipfsGateway: options.gateway,
        skipDecryption: options.skipDecryption,
        tacoOptions,
        verbose: options.verbose,
        saveCarFiles: options.saveCar,
      }
    );

    if (result.success) {
      console.log(`\n✅ Recovery successful!`);
      console.log(`   Output: ${result.outputPath}`);
      if (result.warnings?.length) {
        console.log("\n⚠️  Warnings:");
        result.warnings.forEach(w => console.log(`   - ${w}`));
      }
    } else {
      console.log(`\n❌ Recovery failed:`);
      console.log(`   Error: ${result.error}`);
      process.exit(1);
    }
  });

// ── Recover All Command ─────────────────────────────────────────────────────

program
  .command("recover-all")
  .description("Recover all conversations from metadata directory or CID list file")
  .option("-m, --metadata-dir <dir>", "Directory containing metadata JSON files")
  .option("-c, --cid-file <file>", "File containing list of CIDs (one per line)")
  .option("-g, --gateway <url>", "IPFS gateway URL", "https://ipfs.io")
  .option("-o, --output <dir>", "Output directory", "./recovered")
  .option("--skip-decryption", "Skip decryption even if data is encrypted")
  .option("--tacO-domain <domain>", "TACo domain")
  .option("--tacO-ritual-id <id>", "TACo ritual ID", "27")
  .option("--tacO-private-key <key>", "TACo private key")
  .option("--rpc-url <url>", "Blockchain RPC URL")
  .option("--save-car", "Save raw CAR files")
  .option("--verbose", "Enable verbose logging")
  .action(async (options) => {
    console.log("\n🔧 LM Studio Bridge Data Recovery (Batch Mode)\n");

    // Get list of CIDs to recover
    let cidsToRecover: string[] = [];

    if (options.metadataDir) {
      console.log(`Loading CIDs from metadata directory: ${options.metadataDir}`);
      const available = await listAvailableCids(options.metadataDir);
      cidsToRecover = available.map(m => m.cid);
      console.log(`Found ${cidsToRecover.length} CIDs\n`);
    } else if (options.cidFile) {
      if (!fs.existsSync(options.cidFile)) {
        console.error(`CID file not found: ${options.cidFile}`);
        process.exit(1);
      }
      const content = fs.readFileSync(options.cidFile, "utf-8");
      cidsToRecover = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith("#"));
      console.log(`Loaded ${cidsToRecover.length} CIDs from ${options.cidFile}\n`);
    } else {
      console.error("Error: Must specify --metadata-dir or --cid-file");
      process.exit(1);
    }

    if (cidsToRecover.length === 0) {
      console.log("No CIDs to recover.");
      return;
    }

    // Prepare TACo options
    const tacoOptions: TacoDecryptionOptions | undefined =
      options.tacoDomain || options.tacoRitualId || options.tacoPrivateKey || options.rpcUrl
        ? {
            domain: options.tacoDomain || "lynx",
            ritualId: parseInt(options.tacoRitualId, 10),
            privateKey: options.tacoPrivateKey,
            rpcUrl: options.rpcUrl,
          }
        : undefined;

    // Recover all
    const results = await recoverConversations(
      cidsToRecover.map(cid => ({ type: "cid" as const, cid })),
      {
        outputDir: options.output,
        ipfsGateway: options.gateway,
        skipDecryption: options.skipDecryption,
        tacoOptions,
        verbose: options.verbose,
        saveCarFiles: options.saveCar,
      }
    );

    // Print summary
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`\n${"=".repeat(40)}`);
    console.log(`Batch Recovery Complete`);
    console.log(`${"=".repeat(40)}`);
    console.log(`Success: ${success}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}`);

    if (failed > 0) {
      console.log("\nFailed CIDs:");
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.cid}: ${r.error}`);
      });
      process.exit(1);
    }
  });

// ── List Command ────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List available CIDs from metadata directory")
  .option("-m, --metadata-dir <dir>", "Directory containing metadata JSON files", "./data")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    if (!fs.existsSync(options.metadataDir)) {
      console.error(`Metadata directory not found: ${options.metadataDir}`);
      process.exit(1);
    }

    const available = await listAvailableCids(options.metadataDir);

    if (options.json) {
      console.log(JSON.stringify(available, null, 2));
    } else {
      console.log(`\n📋 Available CIDs (${available.length} total)\n`);
      
      if (available.length === 0) {
        console.log("No CIDs found in metadata directory.");
        return;
      }

      for (const item of available) {
        const status = item.encrypted ? "🔐" : "📄";
        console.log(`${status} ${item.cid}`);
        if (item.timestamp) {
          console.log(`   Timestamp: ${item.timestamp}`);
        }
        if (item.size) {
          console.log(`   Size: ${item.size} bytes`);
        }
      }
    }
  });

// ── Decrypt Command ─────────────────────────────────────────────────────────

program
  .command("decrypt <cid>")
  .description("Decrypt an encrypted conversation")
  .option("-g, --gateway <url>", "IPFS gateway URL", "https://ipfs.io")
  .option("-o, --output <dir>", "Output directory", "./decrypted")
  .option("--tacO-domain <domain>", "TACo domain (required)", "lynx")
  .option("--tacO-ritual-id <id>", "TACo ritual ID", "27")
  .option("--tacO-private-key <key>", "TACo private key (required)")
  .option("--rpc-url <url>", "Blockchain RPC URL")
  .action(async (cid, options) => {
    console.log("\n🔐 TACo Decryption\n");
    console.log(`CID: ${cid}`);
    console.log(`TACo Domain: ${options.tacoDomain}`);
    console.log(`Ritual ID: ${options.tacoRitualId}`);

    if (!options.tacoPrivateKey) {
      console.error("\n❌ Error: --tacO-private-key is required for decryption");
      process.exit(1);
    }

    try {
      // Retrieve and parse CAR
      const { retrieveFromGateway } = await import("./lib/retriever");
      const retrieval = await retrieveFromGateway(cid, {
        gatewayUrl: options.gateway,
      });

      const carData = await parseCarFile(retrieval.carBytes);
      const conversation = await extractConversation(carData);

      console.log(`\nConversation retrieved: ${conversation.request.model}`);
      console.log(`Messages: ${conversation.request.messages.length}`);

      // Note: Full decryption requires the encrypted buffer
      // This would typically come from the upload metadata
      console.log("\n⚠️  Note: Full decryption requires the encrypted payload buffer");
      console.log("   which is stored separately from the IPLD conversation data.");
      console.log("   Check your upload logs or metadata files for the encrypted buffer location.");

      // Save what we can
      const outputPath = path.join(options.output, `${cid}-metadata.json`);
      fs.mkdirSync(options.output, { recursive: true });
      fs.writeFileSync(
        outputPath,
        JSON.stringify({
          cid,
          conversation,
          metadata: conversation.metadata,
          decryptionNote: "Encrypted payload requires separate retrieval",
        }, null, 2),
        "utf-8"
      );

      console.log(`\nSaved metadata to: ${outputPath}`);
    } catch (error) {
      console.error("\n❌ Decryption failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ── Extract Command ─────────────────────────────────────────────────────────

program
  .command("extract <car-file>")
  .description("Extract conversation from a local CAR file")
  .option("-o, --output <path>", "Output file path")
  .option("--format <format>", "Output format: json, pretty-json, ndjson", "pretty-json")
  .action(async (carFile, options) => {
    console.log("\n📦 CAR File Extraction\n");
    console.log(`File: ${carFile}`);

    if (!fs.existsSync(carFile)) {
      console.error(`Error: CAR file not found: ${carFile}`);
      process.exit(1);
    }

    try {
      const retrieval = await loadLocalCarFile(carFile);
      const carData = await parseCarFile(retrieval.carBytes);
      const conversation = await extractConversation(carData);

      console.log(`\n✅ Successfully extracted conversation`);
      console.log(`   Model: ${conversation.request.model}`);
      console.log(`   Messages: ${conversation.request.messages.length}`);
      console.log(`   Root CID: ${carData.rootCid}`);

      // Determine output path
      let outputPath = options.output;
      if (!outputPath) {
        const baseName = path.basename(carFile, ".car");
        outputPath = path.join(process.cwd(), `${baseName}-extracted.json`);
      }

      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write output
      const output = JSON.stringify(conversation, null, 2);
      fs.writeFileSync(outputPath, output, "utf-8");

      console.log(`\nSaved to: ${outputPath}`);
    } catch (error) {
      console.error("\n❌ Extraction failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ── Main ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
