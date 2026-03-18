/**
 * Archive Builder Tests
 *
 * Tests for the v2 batch-level IPLD archive builder.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildBatchArchive,
  readArchive,
  verifyArchive,
  ArchiveConversation,
} from "../src/lib/archive-builder";

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeConversation(id: string, model: string = "gpt-4"): ArchiveConversation {
  return {
    id,
    timestamp: Date.now(),
    model,
    request: {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: `Hello from conversation ${id}` },
      ],
      parameters: { temperature: 0.7, max_tokens: 100 },
    },
    response: {
      id: `resp-${id}`,
      model,
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `Response for ${id}` },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("archive-builder", () => {
  describe("buildBatchArchive", () => {
    it("builds a valid CAR with correct block count", async () => {
      const conversations = [makeConversation("req-1"), makeConversation("req-2")];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);

      // 2 conversation blocks + 1 batch root = 3 blocks
      expect(result.blockCount).toBe(3);
      expect(result.carBytes).toBeInstanceOf(Uint8Array);
      expect(result.carBytes.length).toBeGreaterThan(0);
    });

    it("creates one block per conversation plus one batch root", async () => {
      const conversations = [
        makeConversation("req-1"),
        makeConversation("req-2"),
        makeConversation("req-3"),
      ];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);

      expect(result.blockCount).toBe(4); // 3 conversations + 1 root
      expect(result.conversationCids.size).toBe(3);
    });

    it("links batch root to all conversation CIDs", async () => {
      const conversations = [makeConversation("req-1"), makeConversation("req-2")];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);

      // Read back and verify
      const { root } = await readArchive(result.carBytes);
      expect(root.conversationCount).toBe(2);
      expect(root.conversations.length).toBe(2);
    });

    it("sets previousBatch to null for genesis batch", async () => {
      const conversations = [makeConversation("req-1")];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);

      const { root } = await readArchive(result.carBytes);
      expect(root.previousBatch).toBeNull();
    });

    it("sets previousBatch CID for subsequent batches", async () => {
      const conv1 = [makeConversation("req-1")];
      const result1 = await buildBatchArchive(conv1, 1, "2.0.0", null);

      const conv2 = [makeConversation("req-2")];
      const result2 = await buildBatchArchive(conv2, 2, "2.0.0", result1.rootCid);

      const { root } = await readArchive(result2.carBytes);
      expect(root.previousBatch).not.toBeNull();
      expect(root.previousBatch!.toString()).toBe(result1.rootCid.toString());
    });

    it("handles encrypted conversations (encryptedPayload)", async () => {
      const conv: ArchiveConversation = {
        ...makeConversation("req-enc"),
        encrypted: true,
        encryptedPayload: new Uint8Array([1, 2, 3, 4, 5]),
      };

      const result = await buildBatchArchive([conv], 1, "2.0.0", null);
      expect(result.blockCount).toBe(2); // 1 conversation + 1 root

      const { conversations } = await readArchive(result.carBytes);
      const decoded = [...conversations.values()][0];
      expect(decoded.encrypted).toBe(true);
      expect(decoded.encryptedPayload).toBeDefined();
    });

    it("computes correct metadata (models, totalTokens, captureWindow)", async () => {
      const conv1 = makeConversation("req-1", "gpt-4");
      conv1.timestamp = 1000;
      conv1.response.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

      const conv2 = makeConversation("req-2", "llama-3");
      conv2.timestamp = 2000;
      conv2.response.usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };

      const result = await buildBatchArchive([conv1, conv2], 1, "2.0.0", null);
      const { root } = await readArchive(result.carBytes);

      expect(root.metadata.totalTokens).toBe(45);
      expect(root.metadata.models).toContain("gpt-4");
      expect(root.metadata.models).toContain("llama-3");
      expect(root.metadata.captureWindow.start).toBe(1000);
      expect(root.metadata.captureWindow.end).toBe(2000);
    });

    it("produces deterministic CIDs for identical input", async () => {
      const conv = makeConversation("req-1");
      conv.timestamp = 12345; // Fixed timestamp

      const result1 = await buildBatchArchive([conv], 1, "2.0.0", null);
      const result2 = await buildBatchArchive([conv], 1, "2.0.0", null);

      // Conversation CIDs should be identical (same input)
      const cid1 = result1.conversationCids.get("req-1")!.toString();
      const cid2 = result2.conversationCids.get("req-1")!.toString();
      expect(cid1).toBe(cid2);
    });
  });

  describe("readArchive", () => {
    it("round-trips: build → read → verify all conversations present", async () => {
      const conversations = [
        makeConversation("req-1"),
        makeConversation("req-2"),
        makeConversation("req-3"),
      ];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);
      const { root, conversations: decoded } = await readArchive(result.carBytes);

      expect(root.conversationCount).toBe(3);
      expect(decoded.size).toBe(3);
    });

    it("decodes conversation blocks back to ArchiveConversation", async () => {
      const conv = makeConversation("req-1");
      conv.request.messages = [
        { role: "user", content: "What is 2+2?" },
      ];
      conv.response.choices = [
        { index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" },
      ];

      const result = await buildBatchArchive([conv], 1, "2.0.0", null);
      const { conversations } = await readArchive(result.carBytes);

      const decoded = [...conversations.values()][0];
      expect(decoded.id).toBe("req-1");
      expect(decoded.request.messages[0].content).toBe("What is 2+2?");
      expect(decoded.response.choices[0].message.content).toBe("4");
    });

    it("returns correct batch root with all fields", async () => {
      const conversations = [makeConversation("req-1", "gpt-4")];
      const result = await buildBatchArchive(conversations, 42, "2.0.0", null);
      const { root } = await readArchive(result.carBytes);

      expect(root.version).toBe("2.0.0");
      expect(root.schemaVersion).toBe("conversation-archive/2.0.0");
      expect(root.batchId).toBe(42);
      expect(root.conversationCount).toBe(1);
      expect(root.metadata.shimVersion).toBe("2.0.0");
    });
  });

  describe("verifyArchive", () => {
    it("returns valid for a correctly built archive", async () => {
      const conversations = [makeConversation("req-1"), makeConversation("req-2")];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);

      const verification = await verifyArchive(result.carBytes);
      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });

    it("returns invalid if a block is tampered with", async () => {
      const conversations = [makeConversation("req-1")];
      const result = await buildBatchArchive(conversations, 1, "2.0.0", null);

      // Tamper with the CAR bytes (modify a byte near the end of the data section)
      const tampered = new Uint8Array(result.carBytes);
      // Flip a byte in the middle of the data
      const midpoint = Math.floor(tampered.length / 2);
      tampered[midpoint] = tampered[midpoint] ^ 0xff;

      const verification = await verifyArchive(tampered);
      // Should either fail to parse or detect CID mismatch
      expect(verification.valid).toBe(false);
      expect(verification.errors.length).toBeGreaterThan(0);
    });

    it("returns invalid for garbage data", async () => {
      const garbage = new Uint8Array([0, 1, 2, 3, 4, 5]);
      const verification = await verifyArchive(garbage);
      expect(verification.valid).toBe(false);
      expect(verification.errors.length).toBeGreaterThan(0);
    });
  });
});
