/**
 * CLI Entry Point for LM Studio Bridge Data Recovery — V2 Architecture
 *
 * Usage:
 *   lmbridge-recover recover <CID> [options]       Recover a batch by CID
 *   lmbridge-recover recover-all [options]          Recover all batches from registry
 *   lmbridge-recover list [options]                 List batches from registry
 *   lmbridge-recover extract <CAR-file> [options]   Extract from local CAR file
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  recoverBatch,
  recoverBatches,
  listBatchesFromRegistry,
} from "./lib/recovery";
import { loadLocalCarFile } from "./lib/retriever";
import { parseCarFile, extractBatch, saveBatchToFile, saveConversationsToDir } from "./lib/car-extractor";
import { TacoDecryptionOptions } from "./lib/decryptor";

const program = new Command();

program
  .name("lmbridge-recover")
  .description("LM Studio Bridge Data Recovery Tool (v2 format)")
  .version("2.0.0");

// ── Recover Command ─────────────────────────────────────────────────────────

program
  .command("recover <cid>")
  .description("Recover a batch from IPFS by CID (v2 batch format)")
  .option("-g, --gateway <url>", "IPFS gateway URL", "https://ipfs.io")
  .option("-o, --output <dir>", "Output directory", "./recovered")
  .option("--split", "Save individual conversations as separate files")
  .option("--format <format>", "Output format: json, pretty-json, ndjson", "pretty-json")
  .option("--skip-decryption", "Skip decryption even if data is encrypted")
  .option("--taco-domain <domain>", "TACo domain (e.g., lynx, ursula)")
  .option("--taco-ritual-id <id>", "TACo ritual ID", "27")
  .option("--taco-private-key <key>", "TACo private key for authentication")
  .option("--rpc-url <url>", "Blockchain RPC URL")
  .option("--save-car", "Save raw CAR files to output directory")
  .option("--verbose", "Enable verbose logging")
  .action(async (cid, options) => {
    console.log("\n🔧 LM Studio Bridge Data Recovery (v2)\n");
    console.log(`CID: ${cid}`);
    console.log(`Gateway: ${options.gateway}`);
    console.log(`Output: ${options.output}\n`);

    const tacoOptions: TacoDecryptionOptions | undefined =
      options.tacoDomain || options.tacoRitualId || options.tacoPrivateKey || options.rpcUrl
        ? {
            domain: options.tacoDomain || "lynx",
            ritualId: parseInt(options.tacoRitualId, 10),
            privateKey: options.tacoPrivateKey,
            rpcUrl: options.rpcUrl,
          }
        : undefined;

    const result = await recoverBatch(
      { type: "cid", cid },
      {
        outputDir: options.output,
        ipfsGateway: options.gateway,
        skipDecryption: options.skipDecryption,
        tacoOptions,
        verbose: options.verbose,
        saveCarFiles: options.saveCar,
        splitConversations: options.split,
        format: options.format,
      }
    );

    if (result.success) {
      console.log(`\n✅ Recovery successful!`);
      console.log(`   Batch output: ${result.outputPath}`);
      console.log(`   Conversations: ${result.batch?.conversations.size ?? 0}`);
      if (result.conversationPaths) {
        console.log(`   Individual files: ${result.conversationPaths.length}`);
      }
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
  .description("Recover all batches from a v2 registry file or CID list")
  .option("-r, --registry <file>", "Path to v2 registry.json file")
  .option("-c, --cid-file <file>", "File containing list of CIDs (one per line)")
  .option("-g, --gateway <url>", "IPFS gateway URL", "https://ipfs.io")
  .option("-o, --output <dir>", "Output directory", "./recovered")
  .option("--split", "Save individual conversations as separate files")
  .option("--format <format>", "Output format: json, pretty-json, ndjson", "pretty-json")
  .option("--skip-decryption", "Skip decryption even if data is encrypted")
  .option("--taco-domain <domain>", "TACo domain")
  .option("--taco-ritual-id <id>", "TACo ritual ID", "27")
  .option("--taco-private-key <key>", "TACo private key")
  .option("--rpc-url <url>", "Blockchain RPC URL")
  .option("--save-car", "Save raw CAR files")
  .option("--verbose", "Enable verbose logging")
  .action(async (options) => {
    console.log("\n🔧 LM Studio Bridge Data Recovery — Batch Mode (v2)\n");

    let cidsToRecover: string[] = [];

    if (options.registry) {
      console.log(`Loading batches from registry: ${options.registry}`);
      const batches = await listBatchesFromRegistry(options.registry);
      cidsToRecover = batches.map(b => b.filecoinCid);
      console.log(`Found ${cidsToRecover.length} batches\n`);
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
      console.error("Error: Must specify --registry or --cid-file");
      process.exit(1);
    }

    if (cidsToRecover.length === 0) {
      console.log("No batches to recover.");
      return;
    }

    const tacoOptions: TacoDecryptionOptions | undefined =
      options.tacoDomain || options.tacoRitualId || options.tacoPrivateKey || options.rpcUrl
        ? {
            domain: options.tacoDomain || "lynx",
            ritualId: parseInt(options.tacoRitualId, 10),
            privateKey: options.tacoPrivateKey,
            rpcUrl: options.rpcUrl,
          }
        : undefined;

    const results = await recoverBatches(
      cidsToRecover.map(cid => ({ type: "cid" as const, cid })),
      {
        outputDir: options.output,
        ipfsGateway: options.gateway,
        skipDecryption: options.skipDecryption,
        tacoOptions,
        verbose: options.verbose,
        saveCarFiles: options.saveCar,
        splitConversations: options.split,
        format: options.format,
      }
    );

    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    if (failed > 0) {
      console.log("\nFailed batches:");
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.source}: ${r.error}`);
      });
      process.exit(1);
    }
  });

// ── List Command ────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List batches from a v2 registry file")
  .option("-r, --registry <file>", "Path to v2 registry.json file", "./registry.json")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    if (!fs.existsSync(options.registry)) {
      console.error(`Registry file not found: ${options.registry}`);
      process.exit(1);
    }

    const batches = await listBatchesFromRegistry(options.registry);

    if (options.json) {
      console.log(JSON.stringify(batches, null, 2));
    } else {
      console.log(`\n📋 V2 Batches (${batches.length} total)\n`);

      if (batches.length === 0) {
        console.log("No batches found in registry.");
        return;
      }

      for (const batch of batches) {
        const date = new Date(batch.createdAt).toISOString();
        const chain = batch.previousBatchCid ? `← ${batch.previousBatchCid.substring(0, 16)}...` : "(genesis)";
        console.log(`📦 Batch #${batch.batchId}`);
        console.log(`   Root CID:      ${batch.rootCid}`);
        console.log(`   Filecoin CID:  ${batch.filecoinCid}`);
        console.log(`   Conversations: ${batch.conversationCount}`);
        console.log(`   CAR size:      ${batch.carSize} bytes`);
        console.log(`   Created:       ${date}`);
        console.log(`   Chain:         ${chain}`);
        console.log();
      }
    }
  });

// ── Extract Command ─────────────────────────────────────────────────────────

program
  .command("extract <car-file>")
  .description("Extract a v2 batch from a local CAR file")
  .option("-o, --output <path>", "Output file or directory path")
  .option("--split", "Save individual conversations as separate files")
  .option("--format <format>", "Output format: json, pretty-json, ndjson", "pretty-json")
  .action(async (carFile, options) => {
    console.log("\n📦 V2 CAR File Extraction\n");
    console.log(`File: ${carFile}`);

    if (!fs.existsSync(carFile)) {
      console.error(`Error: CAR file not found: ${carFile}`);
      process.exit(1);
    }

    try {
      const retrieval = await loadLocalCarFile(carFile);
      const carData = await parseCarFile(retrieval.carBytes);
      const batch = await extractBatch(carData);

      console.log(`\n✅ Successfully extracted v2 batch`);
      console.log(`   Version:       ${batch.batchRoot.version}`);
      console.log(`   Batch ID:      ${batch.batchRoot.batchId}`);
      console.log(`   Conversations: ${batch.conversations.size}`);
      console.log(`   Models:        ${batch.batchRoot.metadata.models.join(", ")}`);
      console.log(`   Total tokens:  ${batch.batchRoot.metadata.totalTokens}`);
      console.log(`   Root CID:      ${batch.rootCid}`);

      if (batch.batchRoot.previousBatch) {
        console.log(`   Prev batch:    ${batch.batchRoot.previousBatch.toString()}`);
      }

      // Determine output
      const outputDir = options.output ?? process.cwd();

      if (options.split) {
        const convDir = path.join(outputDir, `batch-${batch.batchRoot.batchId}-conversations`);
        const paths = await saveConversationsToDir(batch, convDir, { format: options.format });
        console.log(`\nSaved ${paths.length} conversations to: ${convDir}`);
      } else {
        const outputPath = path.isAbsolute(outputDir)
          ? outputDir
          : path.join(process.cwd(), outputDir);

        // If output looks like a directory, put batch file inside it
        let finalPath: string;
        if (outputPath.endsWith(".json") || outputPath.endsWith(".ndjson")) {
          finalPath = outputPath;
        } else {
          fs.mkdirSync(outputPath, { recursive: true });
          const baseName = path.basename(carFile, ".car");
          finalPath = path.join(outputPath, `${baseName}-extracted.json`);
        }

        await saveBatchToFile(batch, finalPath, { format: options.format });
        console.log(`\nSaved to: ${finalPath}`);
      }
    } catch (error) {
      console.error("\n❌ Extraction failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ── Main ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
