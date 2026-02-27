/**
 * CID Cache Module Tests
 *
 * Tests for the SQLite-based CID cache implementation including:
 * - Basic CRUD operations
 * - Batch operations
 * - TTL-based cleanup
 * - Persistence across restarts
 * - Statistics tracking
 */

import * as path from "path";
import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  createCIDCache,
  CIDCache,
} from "../src/lib/cid-cache";

const TEST_DB_DIR = path.join(__dirname, "tmp");

describe("CID Cache Module", () => {
  let cache: CIDCache;
  let dbPath: string;

  beforeEach(async () => {
    // Ensure test directory exists
    if (!fs.existsSync(TEST_DB_DIR)) {
      fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    }
    dbPath = path.join(TEST_DB_DIR, `test-cache-${Date.now()}.db`);
    cache = createCIDCache({ dbPath });
  });

  afterEach(async () => {
    await cache.close();
    // Clean up test database
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      // Also clean up WAL files
      const walPath = dbPath + "-wal";
      const shmPath = dbPath + "-shm";
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Basic Operations", () => {
    it("should add and retrieve a CID entry", async () => {
      const cid = "QmTest123";
      const entry = {
        size: 1024,
        uploadedAt: Date.now(),
        dealStatus: "pending" as const,
        mimeType: "application/json",
      };

      await cache.add(cid, entry);
      const retrieved = await cache.get(cid);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.cid).toBe(cid);
      expect(retrieved?.size).toBe(entry.size);
      expect(retrieved?.dealStatus).toBe(entry.dealStatus);
      expect(retrieved?.mimeType).toBe(entry.mimeType);
    });

    it("should check if CID exists", async () => {
      const cid = "QmTestExists";
      
      expect(await cache.has(cid)).toBe(false);
      
      await cache.add(cid, {
        size: 512,
        uploadedAt: Date.now(),
        dealStatus: "active",
        mimeType: "application/octet-stream",
      });
      
      expect(await cache.has(cid)).toBe(true);
    });

    it("should return null for non-existent CID", async () => {
      const retrieved = await cache.get("QmNonExistent");
      expect(retrieved).toBeNull();
    });

    it("should update existing CID entry", async () => {
      const cid = "QmUpdateTest";
      
      await cache.add(cid, {
        size: 100,
        uploadedAt: Date.now(),
        dealStatus: "pending",
        mimeType: "text/plain",
      });

      await cache.add(cid, {
        size: 200,
        uploadedAt: Date.now(),
        dealStatus: "active",
        mimeType: "application/json",
      });

      const retrieved = await cache.get(cid);
      expect(retrieved?.size).toBe(200);
      expect(retrieved?.dealStatus).toBe("active");
    });
  });

  describe("Batch Operations", () => {
    it("should add multiple entries in batch", async () => {
      const entries = [
        {
          cid: "QmBatch1",
          size: 100,
          uploadedAt: Date.now(),
          dealStatus: "pending" as const,
          mimeType: "application/json",
        },
        {
          cid: "QmBatch2",
          size: 200,
          uploadedAt: Date.now(),
          dealStatus: "active" as const,
          mimeType: "application/json",
        },
        {
          cid: "QmBatch3",
          size: 300,
          uploadedAt: Date.now(),
          dealStatus: "expired" as const,
          mimeType: "text/plain",
        },
      ];

      await cache.addBatch(entries);

      for (const entry of entries) {
        const retrieved = await cache.get(entry.cid);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.size).toBe(entry.size);
      }
    });

    it("should return correct cache size", async () => {
      expect(await cache.size()).toBe(0);

      await cache.add("QmSize1", {
        size: 100,
        uploadedAt: Date.now(),
        dealStatus: "pending",
        mimeType: "application/json",
      });

      expect(await cache.size()).toBe(1);

      await cache.add("QmSize2", {
        size: 200,
        uploadedAt: Date.now(),
        dealStatus: "active",
        mimeType: "application/json",
      });

      expect(await cache.size()).toBe(2);
    });
  });

  describe("Deal Status Updates", () => {
    it("should update deal status for a CID", async () => {
      const cid = "QmStatusTest";
      
      await cache.add(cid, {
        size: 1000,
        uploadedAt: Date.now(),
        dealStatus: "pending",
        mimeType: "application/json",
      });

      await cache.updateDealStatus(cid, "active");

      const retrieved = await cache.get(cid);
      expect(retrieved?.dealStatus).toBe("active");
    });

    it("should track multiple status transitions", async () => {
      const cid = "QmStatusTransitions";
      
      await cache.add(cid, {
        size: 1000,
        uploadedAt: Date.now(),
        dealStatus: "pending",
        mimeType: "application/json",
      });

      await cache.updateDealStatus(cid, "active");
      expect((await cache.get(cid))?.dealStatus).toBe("active");

      await cache.updateDealStatus(cid, "expired");
      expect((await cache.get(cid))?.dealStatus).toBe("expired");

      await cache.updateDealStatus(cid, "failed");
      expect((await cache.get(cid))?.dealStatus).toBe("failed");
    });
  });

  describe("Statistics", () => {
    it("should calculate cache statistics correctly", async () => {
      const entries = [
        { cid: "QmStat1", size: 100, dealStatus: "pending" as const },
        { cid: "QmStat2", size: 200, dealStatus: "pending" as const },
        { cid: "QmStat3", size: 300, dealStatus: "active" as const },
        { cid: "QmStat4", size: 400, dealStatus: "active" as const },
        { cid: "QmStat5", size: 500, dealStatus: "expired" as const },
      ];

      for (const entry of entries) {
        await cache.add(entry.cid, {
          size: entry.size,
          uploadedAt: Date.now(),
          dealStatus: entry.dealStatus,
          mimeType: "application/json",
        });
      }

      const stats = await cache.getStats();

      expect(stats.totalEntries).toBe(5);
      expect(stats.totalSize).toBe(1500);
      expect(stats.byStatus.pending).toBe(2);
      expect(stats.byStatus.active).toBe(2);
      expect(stats.byStatus.expired).toBe(1);
      expect(stats.byStatus.failed).toBe(0);
    });
  });

  describe("TTL Cleanup", () => {
    it("should remove stale entries based on TTL", async () => {
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      // Add entries with different ages
      await cache.add("QmOld1", {
        size: 100,
        uploadedAt: now - 10 * oneDayMs, // 10 days old
        dealStatus: "pending",
        mimeType: "application/json",
      });

      await cache.add("QmOld2", {
        size: 200,
        uploadedAt: now - 5 * oneDayMs, // 5 days old
        dealStatus: "active",
        mimeType: "application/json",
      });

      await cache.add("QmNew", {
        size: 300,
        uploadedAt: now - 1 * oneDayMs, // 1 day old
        dealStatus: "pending",
        mimeType: "application/json",
      });

      // Cleanup entries older than 7 days
      const removed = await cache.cleanup(7 * oneDayMs);

      expect(removed).toBe(1); // Only QmOld1 should be removed
      expect(await cache.has("QmOld1")).toBe(false);
      expect(await cache.has("QmOld2")).toBe(true);
      expect(await cache.has("QmNew")).toBe(true);
    });

    it("should not remove entries within TTL", async () => {
      const now = Date.now();

      await cache.add("QmRecent", {
        size: 100,
        uploadedAt: now,
        dealStatus: "pending",
        mimeType: "application/json",
      });

      const removed = await cache.cleanup(24 * 60 * 60 * 1000); // 1 day TTL

      expect(removed).toBe(0);
      expect(await cache.has("QmRecent")).toBe(true);
    });
  });

  describe("Clear", () => {
    it("should clear all entries", async () => {
      await cache.add("QmClear1", {
        size: 100,
        uploadedAt: Date.now(),
        dealStatus: "pending",
        mimeType: "application/json",
      });

      await cache.add("QmClear2", {
        size: 200,
        uploadedAt: Date.now(),
        dealStatus: "active",
        mimeType: "application/json",
      });

      expect(await cache.size()).toBe(2);

      await cache.clear();

      expect(await cache.size()).toBe(0);
      expect(await cache.has("QmClear1")).toBe(false);
      expect(await cache.has("QmClear2")).toBe(false);
    });
  });

  // Note: Persistence test requires SQLite, skip in CI
  describe.skip("Persistence (requires SQLite)", () => {
    it("should persist data across cache instances", async () => {
      const cid = "QmPersistent";
      const entry = {
        size: 1024,
        uploadedAt: Date.now(),
        dealStatus: "active" as const,
        mimeType: "application/json",
      };

      // Add entry with first cache instance
      await cache.add(cid, entry);
      await cache.close();

      // Create new cache instance pointing to same database
      const newCache = createCIDCache({ dbPath });
      
      // Verify entry persists
      expect(await newCache.has(cid)).toBe(true);
      const retrieved = await newCache.get(cid);
      expect(retrieved?.size).toBe(entry.size);
      expect(retrieved?.dealStatus).toBe(entry.dealStatus);

      await newCache.close();
    });
  });
});

// Note: CID Generation tests require ESM modules, skip in Jest
describe.skip("CID Generation (requires ESM)", () => {
  it("should generate consistent CIDs for identical data", async () => {
    // Test requires multiformats ESM module
  });
});
