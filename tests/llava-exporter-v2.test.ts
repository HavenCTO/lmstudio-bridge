/**
 * LLaVA Exporter v2 Tests
 *
 * Integration tests for the v2 exporter reading v2 CARs.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { buildBatchArchive, ArchiveConversation } from "../src/lib/archive-builder";
import { LLaVAExporter } from "../src/export/llava-exporter";

// ── Test Helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llava-export-test-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function makeConversation(
  id: string,
  userMsg: string,
  assistantMsg: string,
  model: string = "gpt-4"
): ArchiveConversation {
  return {
    id,
    timestamp: Date.now(),
    model,
    request: {
      messages: [
        { role: "user", content: userMsg },
      ],
    },
    response: {
      id: `resp-${id}`,
      model,
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: assistantMsg },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("llava-exporter v2", () => {
  it("exports conversations from a v2 CAR to JSONL", async () => {
    const conversations = [
      makeConversation("req-1", "Hello", "Hi there!"),
      makeConversation("req-2", "How are you?", "I'm doing well!"),
    ];

    const archive = await buildBatchArchive(conversations, 1, "2.0.0", null);

    // Write CAR to disk
    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    // Export
    const exporter = new LLaVAExporter({
      outputDir: tmpDir,
      batchId: 1,
    });

    const result = await exporter.export(carPath);

    expect(result.conversationCount).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(result.jsonlPath).toContain("batch-000001.jsonl");

    // Read and verify JSONL
    const content = await fs.readFile(result.jsonlPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].conversations).toBeDefined();
    expect(parsed[1].conversations).toBeDefined();
  });

  it("maps user messages to 'human' role", async () => {
    const conv = makeConversation("req-1", "Hello world", "Hi!");
    const archive = await buildBatchArchive([conv], 1, "2.0.0", null);

    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    const exporter = new LLaVAExporter({ outputDir: tmpDir, batchId: 1 });
    const result = await exporter.export(carPath);

    const content = await fs.readFile(result.jsonlPath, "utf-8");
    const parsed = JSON.parse(content.trim());

    const humanTurns = parsed.conversations.filter((t: any) => t.from === "human");
    expect(humanTurns.length).toBeGreaterThan(0);
    expect(humanTurns[0].value).toBe("Hello world");
  });

  it("maps assistant messages to 'gpt' role", async () => {
    const conv = makeConversation("req-1", "Hello", "I am an assistant");
    const archive = await buildBatchArchive([conv], 1, "2.0.0", null);

    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    const exporter = new LLaVAExporter({ outputDir: tmpDir, batchId: 1 });
    const result = await exporter.export(carPath);

    const content = await fs.readFile(result.jsonlPath, "utf-8");
    const parsed = JSON.parse(content.trim());

    const gptTurns = parsed.conversations.filter((t: any) => t.from === "gpt");
    expect(gptTurns.length).toBeGreaterThan(0);
    expect(gptTurns[0].value).toBe("I am an assistant");
  });

  it("handles system messages", async () => {
    const conv: ArchiveConversation = {
      id: "req-sys",
      timestamp: Date.now(),
      model: "gpt-4",
      request: {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
      },
      response: {
        id: "resp-sys",
        model: "gpt-4",
        created: Math.floor(Date.now() / 1000),
        choices: [
          { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
        ],
      },
    };

    const archive = await buildBatchArchive([conv], 1, "2.0.0", null);
    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    const exporter = new LLaVAExporter({ outputDir: tmpDir, batchId: 1 });
    const result = await exporter.export(carPath);

    expect(result.conversationCount).toBe(1);
    expect(result.errors).toHaveLength(0);

    const content = await fs.readFile(result.jsonlPath, "utf-8");
    const parsed = JSON.parse(content.trim());

    // System message should be included as a turn
    expect(parsed.conversations.length).toBeGreaterThanOrEqual(3); // system + user + assistant
  });

  it("handles multi-part content (text + image_url)", async () => {
    const conv: ArchiveConversation = {
      id: "req-multi",
      timestamp: Date.now(),
      model: "gpt-4-vision",
      request: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
            ],
          },
        ],
      },
      response: {
        id: "resp-multi",
        model: "gpt-4-vision",
        created: Math.floor(Date.now() / 1000),
        choices: [
          { index: 0, message: { role: "assistant", content: "A cat." }, finish_reason: "stop" },
        ],
      },
    };

    const archive = await buildBatchArchive([conv], 1, "2.0.0", null);
    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    const exporter = new LLaVAExporter({ outputDir: tmpDir, batchId: 1 });
    const result = await exporter.export(carPath);

    expect(result.conversationCount).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("includes response choices as gpt turns", async () => {
    const conv: ArchiveConversation = {
      id: "req-multi-choice",
      timestamp: Date.now(),
      model: "gpt-4",
      request: {
        messages: [{ role: "user", content: "Tell me a joke" }],
      },
      response: {
        id: "resp-multi-choice",
        model: "gpt-4",
        created: Math.floor(Date.now() / 1000),
        choices: [
          { index: 0, message: { role: "assistant", content: "Why did the chicken cross the road?" }, finish_reason: "stop" },
        ],
      },
    };

    const archive = await buildBatchArchive([conv], 1, "2.0.0", null);
    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    const exporter = new LLaVAExporter({ outputDir: tmpDir, batchId: 1 });
    const result = await exporter.export(carPath);

    const content = await fs.readFile(result.jsonlPath, "utf-8");
    const parsed = JSON.parse(content.trim());

    const gptTurns = parsed.conversations.filter((t: any) => t.from === "gpt");
    expect(gptTurns.length).toBe(1);
    expect(gptTurns[0].value).toContain("chicken");
  });

  it("writes valid JSONL (one JSON object per line)", async () => {
    const conversations = [
      makeConversation("req-1", "Hello", "Hi"),
      makeConversation("req-2", "Bye", "Goodbye"),
      makeConversation("req-3", "Test", "Response"),
    ];

    const archive = await buildBatchArchive(conversations, 1, "2.0.0", null);
    const carPath = path.join(tmpDir, "test.car");
    await fs.writeFile(carPath, archive.carBytes);

    const exporter = new LLaVAExporter({ outputDir: tmpDir, batchId: 1 });
    const result = await exporter.export(carPath);

    const content = await fs.readFile(result.jsonlPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(3);

    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const obj = JSON.parse(line);
      expect(obj).toHaveProperty("id");
      expect(obj).toHaveProperty("conversations");
      expect(Array.isArray(obj.conversations)).toBe(true);
    }
  });
});
