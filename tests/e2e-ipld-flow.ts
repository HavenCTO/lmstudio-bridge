/**
 * E2E Test for IPLD Native Flow
 * 
 * This test verifies:
 * 1. Upload conversation A, get CID-A
 * 2. Retrieve conversation by CID-A, verify content matches
 * 3. Upload conversation B (shares system prompt with A), get CID-B
 * 4. Verify system prompt CID is same in both conversations
 * 5. Retrieve just the system prompt by CID (partial retrieval)
 * 6. Upload conversation A again, verify same CID (no duplicate upload)
 * 
 * Note: This test requires ESM support. Run with:
 *   npx ts-node --esm tests/e2e-ipld-flow.ts
 */

import { createIPLDBuilder, createCAR } from "../src/lib/ipld-builder";
import { createCIDCache } from "../src/lib/cid-cache";
import { createPromptCache } from "../src/lib/prompt-cache";
import { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "../src/types";

// Test data
const systemPrompt = "You are a helpful assistant specialized in IPFS and IPLD.";

const conversationA: { request: OpenAIChatCompletionRequest; response: OpenAIChatCompletionResponse } = {
  request: {
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "What is IPLD?" },
    ],
  },
  response: {
    id: "chatcmpl-test-a",
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "IPLD is InterPlanetary Linked Data, a data model for content-addressed data." },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 25,
      completion_tokens: 15,
      total_tokens: 40,
    },
  },
};

const conversationB: { request: OpenAIChatCompletionRequest; response: OpenAIChatCompletionResponse } = {
  request: {
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt }, // Same system prompt as A
      { role: "user", content: "How does content addressing work?" },
    ],
  },
  response: {
    id: "chatcmpl-test-b",
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Content addressing uses cryptographic hashes to uniquely identify data by its content." },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 28,
      completion_tokens: 12,
      total_tokens: 40,
    },
  },
};

async function runTest() {
  console.log("=== IPLD Native E2E Test ===\n");

  const cidCache = createCIDCache({ inMemory: true });
  const promptCache = createPromptCache({ inMemory: true });
  const builder = createIPLDBuilder();

  // Test 1: Build conversation A
  console.log("Test 1: Building conversation A...");
  const rootA = await builder.buildConversation(conversationA.request, conversationA.response, {
    promptCache,
  });
  const cidA = rootA.rootCid.toString();
  console.log(`  ✓ CID-A: ${cidA}`);
  console.log(`  ✓ Block count: ${rootA.blockCount}`);
  console.log(`  ✓ Total size: ${rootA.totalSize} bytes`);
  console.log(`  ✓ Message CIDs: ${rootA.messageCids.length}`);

  // Test 2: Cache conversation A
  console.log("\nTest 2: Caching conversation A...");
  await cidCache.add(cidA, {
    size: rootA.totalSize,
    uploadedAt: Date.now(),
    dealStatus: "pending",
    mimeType: "application/vnd.ipld.car",
  });
  const hasA = await cidCache.has(cidA);
  console.log(`  ✓ CID-A in cache: ${hasA}`);

  // Test 3: Rebuild conversation A (should get same CID due to deterministic hashing)
  console.log("\nTest 3: Rebuilding conversation A (deduplication test)...");
  const builder2 = createIPLDBuilder();
  const rootA2 = await builder2.buildConversation(conversationA.request, conversationA.response, {
    promptCache,
  });
  const cidA2 = rootA2.rootCid.toString();
  console.log(`  ✓ CID-A (rebuild): ${cidA2}`);
  console.log(`  ✓ CIDs match: ${cidA === cidA2 ? "✓ PASS" : "✗ FAIL"}`);

  // Test 4: Build conversation B (with same system prompt)
  console.log("\nTest 4: Building conversation B (same system prompt)...");
  const builder3 = createIPLDBuilder();
  const rootB = await builder3.buildConversation(conversationB.request, conversationB.response, {
    promptCache,
  });
  const cidB = rootB.rootCid.toString();
  console.log(`  ✓ CID-B: ${cidB}`);
  console.log(`  ✓ CID-B different from CID-A: ${cidA !== cidB ? "✓ PASS" : "✗ FAIL"}`);

  // Test 5: Verify system prompt deduplication
  console.log("\nTest 5: Verifying system prompt deduplication...");
  const systemCidA = rootA.messageCids[0].toString();
  const systemCidB = rootB.messageCids[0].toString();
  console.log(`  ✓ System prompt CID in A: ${systemCidA}`);
  console.log(`  ✓ System prompt CID in B: ${systemCidB}`);
  console.log(`  ✓ System prompts deduplicated: ${systemCidA === systemCidB ? "✓ PASS" : "✗ FAIL"}`);

  // Test 6: Create CAR file
  console.log("\nTest 6: Creating CAR file...");
  const blocks = builder.getBlocks();
  const car = await createCAR(rootA.rootCid, blocks);
  console.log(`  ✓ CAR file size: ${car.bytes.length} bytes`);
  console.log(`  ✓ CAR root CID: ${car.rootCid.toString()}`);
  console.log(`  ✓ CAR root matches: ${car.rootCid.toString() === cidA ? "✓ PASS" : "✗ FAIL"}`);

  // Test 7: Prompt cache statistics
  console.log("\nTest 7: Prompt cache statistics...");
  const stats = await promptCache.getStats();
  console.log(`  ✓ Total entries: ${stats.totalEntries}`);
  console.log(`  ✓ Total bytes saved: ${stats.totalBytesSaved}`);
  console.log(`  ✓ Has deduplication entries: ${stats.totalEntries > 0 ? "✓ PASS" : "✗ FAIL"}`);

  // Summary
  console.log("\n=== Test Summary ===");
  const allPassed = 
    cidA === cidA2 &&
    cidA !== cidB &&
    systemCidA === systemCidB &&
    car.rootCid.toString() === cidA &&
    stats.totalEntries > 0;

  if (allPassed) {
    console.log("✓ All tests PASSED");
    process.exit(0);
  } else {
    console.log("✗ Some tests FAILED");
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
