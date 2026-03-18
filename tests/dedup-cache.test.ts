/**
 * Dedup Cache Tests
 *
 * Tests for the v2 content-hash deduplication cache.
 */

import { describe, it, expect } from "@jest/globals";
import { createDedupCache, computeContentHash } from "../src/lib/dedup-cache";

describe("dedup-cache", () => {
  it("returns false for unseen hashes", () => {
    const cache = createDedupCache();
    expect(cache.has("abc123")).toBe(false);
    expect(cache.has("def456")).toBe(false);
  });

  it("returns true for previously added hashes", () => {
    const cache = createDedupCache();
    cache.add("abc123");
    cache.add("def456");

    expect(cache.has("abc123")).toBe(true);
    expect(cache.has("def456")).toBe(true);
    expect(cache.has("ghi789")).toBe(false);
  });

  it("tracks size correctly", () => {
    const cache = createDedupCache();
    expect(cache.size()).toBe(0);

    cache.add("a");
    expect(cache.size()).toBe(1);

    cache.add("b");
    expect(cache.size()).toBe(2);

    // Adding duplicate shouldn't increase size
    cache.add("a");
    expect(cache.size()).toBe(2);
  });

  it("clears all entries", () => {
    const cache = createDedupCache();
    cache.add("a");
    cache.add("b");
    cache.add("c");
    expect(cache.size()).toBe(3);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has("a")).toBe(false);
  });

  it("evicts oldest entries when maxEntries exceeded", () => {
    const cache = createDedupCache(10);

    // Add 10 entries
    for (let i = 0; i < 10; i++) {
      cache.add(`hash-${i}`);
    }
    expect(cache.size()).toBe(10);

    // Adding one more should trigger eviction of oldest 10% (1 entry)
    cache.add("hash-10");
    expect(cache.size()).toBeLessThanOrEqual(10);

    // The newest entry should still be present
    expect(cache.has("hash-10")).toBe(true);

    // The oldest entry should have been evicted
    expect(cache.has("hash-0")).toBe(false);
  });

  it("handles re-adding existing entries (LRU refresh)", () => {
    const cache = createDedupCache(5);

    cache.add("a");
    cache.add("b");
    cache.add("c");
    cache.add("d");
    cache.add("e");

    // Re-add "a" to refresh it (move to end)
    cache.add("a");

    // Now add a new entry to trigger eviction
    cache.add("f");

    // "a" should still be present (was refreshed)
    expect(cache.has("a")).toBe(true);
    // "b" should be evicted (was oldest)
    expect(cache.has("b")).toBe(false);
  });
});

describe("computeContentHash", () => {
  it("produces consistent hashes for identical input", async () => {
    const request = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const response = { choices: [{ message: { content: "hi" } }] };

    const hash1 = await computeContentHash(request, response);
    const hash2 = await computeContentHash(request, response);

    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("string");
    expect(hash1.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it("produces different hashes for different content", async () => {
    const request1 = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const response1 = { choices: [{ message: { content: "hi" } }] };

    const request2 = { model: "gpt-4", messages: [{ role: "user", content: "goodbye" }] };
    const response2 = { choices: [{ message: { content: "bye" } }] };

    const hash1 = await computeContentHash(request1, response1);
    const hash2 = await computeContentHash(request2, response2);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different models", async () => {
    const messages = [{ role: "user", content: "hello" }];
    const choices = [{ message: { content: "hi" } }];

    const hash1 = await computeContentHash({ model: "gpt-4", messages }, { choices });
    const hash2 = await computeContentHash({ model: "llama-3", messages }, { choices });

    expect(hash1).not.toBe(hash2);
  });
});
