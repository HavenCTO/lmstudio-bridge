/**
 * Unit tests for the configuration system.
 *
 * Tests config types, file read/write, validation, and config resolution.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  createDefaultConfig,
  ShimConfig,
} from "../src/config/types";
import {
  readConfigFile,
  writeConfigFile,
  validateConfig,
  configFileExists,
  printConfig,
  DEFAULT_CONFIG_PATH,
} from "../src/config/config-file";
import {
  hasExplicitCLIFlags,
} from "../src/config/index";

// Use a temp directory for test config files
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-shim-config-test-"));
});

afterAll(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ── createDefaultConfig ────────────────────────────────────────────────

describe("createDefaultConfig", () => {
  it("should return a valid default config", () => {
    const config = createDefaultConfig();

    expect(config.version).toBe(1);
    expect(config.transport.mode).toBe("http");
    expect(config.transport.port).toBe(8080);
    expect(config.transport.host).toBe("0.0.0.0");
    expect(config.lmstudio.baseUrl).toBe("http://localhost:1234");
    expect(config.lmstudio.timeoutMs).toBe(0);
    expect(config.middleware.logger).toBe(true);
    expect(config.middleware.gzip).toBe(false);
    expect(config.middleware.tacoEncrypt).toBe(false);
    expect(config.middleware.upload).toBe(false);
  });

  it("should have a lastModified timestamp", () => {
    const config = createDefaultConfig();
    expect(config.lastModified).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(config.lastModified).getTime()).not.toBeNaN();
  });
});

// ── writeConfigFile / readConfigFile ───────────────────────────────────

describe("writeConfigFile / readConfigFile", () => {
  it("should write and read a config file", async () => {
    const configPath = path.join(tmpDir, "test-write-read.json");
    const config = createDefaultConfig();
    config.description = "Test config";
    config.transport.port = 9090;

    await writeConfigFile(config, configPath);
    const loaded = await readConfigFile(configPath);

    expect(loaded.description).toBe("Test config");
    expect(loaded.transport.port).toBe(9090);
    expect(loaded.version).toBe(1);
  });

  it("should update lastModified on write", async () => {
    const configPath = path.join(tmpDir, "test-timestamp.json");
    const config = createDefaultConfig();
    const originalTimestamp = config.lastModified;

    // Wait a tiny bit to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    await writeConfigFile(config, configPath);

    const loaded = await readConfigFile(configPath);
    expect(loaded.lastModified).not.toBe(originalTimestamp);
  });

  it("should merge with defaults when reading partial config", async () => {
    const configPath = path.join(tmpDir, "test-partial.json");
    // Write a minimal config (missing many fields)
    const partial = {
      version: 1,
      transport: { mode: "http", port: 3000 },
    };
    await fs.writeFile(configPath, JSON.stringify(partial), "utf-8");

    const loaded = await readConfigFile(configPath);

    // Should have the partial value
    expect(loaded.transport.port).toBe(3000);
    // Should have defaults for missing fields
    expect(loaded.transport.host).toBe("0.0.0.0");
    expect(loaded.lmstudio.baseUrl).toBe("http://localhost:1234");
    expect(loaded.middleware.logger).toBe(true);
  });

  it("should throw on non-existent file", async () => {
    const configPath = path.join(tmpDir, "does-not-exist.json");
    await expect(readConfigFile(configPath)).rejects.toThrow("Config file not found");
  });

  it("should throw on invalid JSON", async () => {
    const configPath = path.join(tmpDir, "test-invalid.json");
    await fs.writeFile(configPath, "{ not valid json }", "utf-8");

    await expect(readConfigFile(configPath)).rejects.toThrow("invalid JSON");
  });

  it("should create directories if needed", async () => {
    const configPath = path.join(tmpDir, "nested", "deep", "config.json");
    const config = createDefaultConfig();

    await writeConfigFile(config, configPath);
    const loaded = await readConfigFile(configPath);

    expect(loaded.version).toBe(1);
  });
});

// ── configFileExists ───────────────────────────────────────────────────

describe("configFileExists", () => {
  it("should return true for existing file", async () => {
    const configPath = path.join(tmpDir, "test-exists.json");
    await fs.writeFile(configPath, "{}", "utf-8");

    expect(await configFileExists(configPath)).toBe(true);
  });

  it("should return false for non-existing file", async () => {
    const configPath = path.join(tmpDir, "nope.json");
    expect(await configFileExists(configPath)).toBe(false);
  });
});

// ── validateConfig ─────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("should validate a default config as valid", () => {
    const config = createDefaultConfig();
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject invalid transport mode", () => {
    const config = createDefaultConfig();
    (config.transport as any).mode = "invalid";
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("transport mode"))).toBe(true);
  });

  it("should reject invalid port", () => {
    const config = createDefaultConfig();
    config.transport.port = 99999;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("port"))).toBe(true);
  });

  it("should reject invalid LM Studio URL", () => {
    const config = createDefaultConfig();
    config.lmstudio.baseUrl = "not-a-url";
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("baseUrl"))).toBe(true);
  });

  it("should reject negative timeout", () => {
    const config = createDefaultConfig();
    config.lmstudio.timeoutMs = -1;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("timeout"))).toBe(true);
  });

  it("should reject invalid gzip level when gzip is enabled", () => {
    const config = createDefaultConfig();
    config.middleware.gzip = true;
    config.middleware.gzipLevel = 15;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("gzip level"))).toBe(true);
  });

  it("should accept valid gzip level", () => {
    const config = createDefaultConfig();
    config.middleware.gzip = true;
    config.middleware.gzipLevel = 9;
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
  });

  it("should require daoContract when taco-encrypt is enabled", () => {
    const config = createDefaultConfig();
    config.middleware.tacoEncrypt = true;
    config.encryption.daoContract = undefined;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("daoContract"))).toBe(true);
  });

  it("should validate taco-encrypt config when all fields are set", () => {
    const config = createDefaultConfig();
    config.middleware.tacoEncrypt = true;
    config.encryption.daoContract = "0x1234567890abcdef";
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
  });

  it("should warn about missing upload key", () => {
    const config = createDefaultConfig();
    config.middleware.upload = true;
    config.upload.synapsePrivateKey = undefined;
    // Clear env var for test
    const origEnv = process.env.HAVEN_PRIVATE_KEY;
    delete process.env.HAVEN_PRIVATE_KEY;

    const result = validateConfig(config);

    // Restore env
    if (origEnv) process.env.HAVEN_PRIVATE_KEY = origEnv;

    expect(result.warnings.some((w) => w.includes("synapsePrivateKey"))).toBe(true);
  });

  it("should reject invalid batchSize", () => {
    const config = createDefaultConfig();
    config.middleware.upload = true;
    config.upload.batchSize = 0;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("batchSize"))).toBe(true);
  });

  it("should reject invalid libp2p protocol", () => {
    const config = createDefaultConfig();
    config.transport.mode = "libp2p";
    config.libp2p.protocol = "/bad/protocol";
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("libp2p protocol"))).toBe(true);
  });

  it("should accept valid libp2p config", () => {
    const config = createDefaultConfig();
    config.transport.mode = "libp2p";
    config.libp2p.protocol = "/x/myprotocol";
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
  });

  it("should reject unsupported config version", () => {
    const config = createDefaultConfig();
    config.version = 99;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });
});

// ── hasExplicitCLIFlags ────────────────────────────────────────────────

describe("hasExplicitCLIFlags", () => {
  it("should return false for no flags", () => {
    expect(hasExplicitCLIFlags(["node", "index.js"])).toBe(false);
  });

  it("should return true for --gzip", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--gzip"])).toBe(true);
  });

  it("should return true for --port", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--port", "9000"])).toBe(true);
  });

  it("should return true for --lmstudio-url", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--lmstudio-url", "http://example.com"])).toBe(true);
  });

  it("should return true for --upload", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--upload"])).toBe(true);
  });

  it("should return true for --taco-encrypt", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--taco-encrypt"])).toBe(true);
  });

  it("should return false for --config (not a middleware flag)", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--config", "my.json"])).toBe(false);
  });

  it("should return true for --webrtc", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--webrtc"])).toBe(true);
  });

  it("should return true for --libp2p", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--libp2p"])).toBe(true);
  });
});

// ── printConfig ────────────────────────────────────────────────────────

describe("printConfig", () => {
  it("should not throw when printing a default config", () => {
    const config = createDefaultConfig();
    // Capture console output
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printConfig(config)).not.toThrow();
    spy.mockRestore();
  });

  it("should not throw when printing a config with all features enabled", () => {
    const config = createDefaultConfig();
    config.middleware.gzip = true;
    config.middleware.tacoEncrypt = true;
    config.middleware.upload = true;
    config.transport.mode = "libp2p";
    config.encryption.daoContract = "0xtest";
    config.description = "Full featured config";

    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printConfig(config)).not.toThrow();
    spy.mockRestore();
  });

  it("should mask API tokens and private keys", () => {
    const config = createDefaultConfig();
    config.lmstudio.apiToken = "secret-token-12345";
    config.middleware.upload = true;
    config.upload.synapsePrivateKey = "0xdeadbeef1234567890";

    const output: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    printConfig(config);
    spy.mockRestore();

    const fullOutput = output.join("\n");
    // Should NOT contain the full token
    expect(fullOutput).not.toContain("secret-token-12345");
    // Should contain masked version
    expect(fullOutput).toContain("****2345");
    // Should NOT contain the full private key
    expect(fullOutput).not.toContain("0xdeadbeef1234567890");
    // Should contain masked version
    expect(fullOutput).toContain("****7890");
  });
});

// ── Client mode validation ─────────────────────────────────────────────

describe("validateConfig (client mode)", () => {
  it("should validate a client WebRTC config with shimUrl", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "webrtc";
    config.clientBridge.shimUrl = "http://192.168.1.100:8081";
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject client WebRTC config without shimUrl", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "webrtc";
    config.clientBridge.shimUrl = undefined;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shimUrl"))).toBe(true);
  });

  it("should reject client WebRTC config with invalid shimUrl", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "webrtc";
    config.clientBridge.shimUrl = "not-a-url";
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shimUrl"))).toBe(true);
  });

  it("should validate a client libp2p config with peerID", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "libp2p";
    config.clientBridge.peerID = "12D3KooWTestPeerID";
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
  });

  it("should reject client libp2p config without peerID", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "libp2p";
    config.clientBridge.peerID = undefined;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("peerID"))).toBe(true);
  });

  it("should reject invalid client transport", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    (config.clientBridge as any).transport = "invalid";
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("client transport"))).toBe(true);
  });

  it("should reject negative client timeout", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "webrtc";
    config.clientBridge.shimUrl = "http://localhost:8081";
    config.clientBridge.timeoutMs = -1;
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("client timeout"))).toBe(true);
  });

  it("should reject invalid mode", () => {
    const config = createDefaultConfig();
    (config as any).mode = "invalid";
    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mode"))).toBe(true);
  });
});

// ── createDefaultConfig (client fields) ────────────────────────────────

describe("createDefaultConfig (client fields)", () => {
  it("should default to server mode", () => {
    const config = createDefaultConfig();
    expect(config.mode).toBe("server");
  });

  it("should have clientBridge defaults", () => {
    const config = createDefaultConfig();
    expect(config.clientBridge).toBeDefined();
    expect(config.clientBridge.transport).toBe("webrtc");
    expect(config.clientBridge.localHost).toBe("127.0.0.1");
    expect(config.clientBridge.signalingPort).toBe(0);
    expect(config.clientBridge.timeoutMs).toBe(120000);
  });
});

// ── hasExplicitCLIFlags (client flags) ─────────────────────────────────

describe("hasExplicitCLIFlags (client flags)", () => {
  it("should return true for --client", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--client"])).toBe(true);
  });

  it("should return true for --shim-url", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--shim-url", "http://example.com"])).toBe(true);
  });

  it("should return true for --peerid", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--peerid", "12D3KooW..."])).toBe(true);
  });

  it("should return true for --client-host", () => {
    expect(hasExplicitCLIFlags(["node", "index.js", "--client-host", "0.0.0.0"])).toBe(true);
  });
});

// ── printConfig (client mode) ──────────────────────────────────────────

describe("printConfig (client mode)", () => {
  it("should not throw when printing a client WebRTC config", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "webrtc";
    config.clientBridge.shimUrl = "http://192.168.1.100:8081";

    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printConfig(config)).not.toThrow();
    spy.mockRestore();
  });

  it("should not throw when printing a client libp2p config", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "libp2p";
    config.clientBridge.peerID = "12D3KooWTestPeerID";

    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(() => printConfig(config)).not.toThrow();
    spy.mockRestore();
  });

  it("should display Client Bridge mode label", () => {
    const config = createDefaultConfig();
    config.mode = "client";
    config.clientBridge.transport = "webrtc";
    config.clientBridge.shimUrl = "http://192.168.1.100:8081";

    const output: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });
    printConfig(config);
    spy.mockRestore();

    const fullOutput = output.join("\n");
    expect(fullOutput).toContain("Client Bridge");
    expect(fullOutput).toContain("webrtc");
  });
});

// ── Round-trip config persistence ──────────────────────────────────────

describe("Config round-trip", () => {
  it("should preserve all fields through write/read cycle", async () => {
    const configPath = path.join(tmpDir, "test-roundtrip.json");
    const config = createDefaultConfig();

    // Set non-default values for everything
    config.description = "Round-trip test";
    config.transport.mode = "webrtc";
    config.transport.port = 9999;
    config.transport.host = "127.0.0.1";
    config.lmstudio.baseUrl = "http://custom:5678";
    config.lmstudio.apiToken = "my-token";
    config.lmstudio.timeoutMs = 30000;
    config.middleware.logger = false;
    config.middleware.gzip = true;
    config.middleware.gzipLevel = 9;
    config.middleware.tacoEncrypt = true;
    config.middleware.upload = true;
    config.encryption.tacoDomain = "mainnet";
    config.encryption.tacoRitualId = 42;
    config.encryption.daoContract = "0xabc123";
    config.encryption.daoChain = "mainnet";
    config.encryption.daoMinBalance = "100";
    config.encryption.keyMetadataPath = "./keys.json";
    config.upload.synapsePrivateKey = "0xprivkey";
    config.upload.synapseRpcUrl = "https://custom-rpc.example.com";
    config.upload.batchSize = 500;
    config.upload.registryPath = "./custom-registry.json";
    config.libp2p.protocol = "/x/custom";
    config.libp2p.ipfsApiUrl = "http://custom-ipfs:5001";
    config.cidRecorder.outputDir = "./custom-cids";

    await writeConfigFile(config, configPath);
    const loaded = await readConfigFile(configPath);

    expect(loaded.description).toBe("Round-trip test");
    expect(loaded.transport.mode).toBe("webrtc");
    expect(loaded.transport.port).toBe(9999);
    expect(loaded.transport.host).toBe("127.0.0.1");
    expect(loaded.lmstudio.baseUrl).toBe("http://custom:5678");
    expect(loaded.lmstudio.apiToken).toBe("my-token");
    expect(loaded.lmstudio.timeoutMs).toBe(30000);
    expect(loaded.middleware.logger).toBe(false);
    expect(loaded.middleware.gzip).toBe(true);
    expect(loaded.middleware.gzipLevel).toBe(9);
    expect(loaded.middleware.tacoEncrypt).toBe(true);
    expect(loaded.middleware.upload).toBe(true);
    expect(loaded.encryption.tacoDomain).toBe("mainnet");
    expect(loaded.encryption.tacoRitualId).toBe(42);
    expect(loaded.encryption.daoContract).toBe("0xabc123");
    expect(loaded.encryption.daoChain).toBe("mainnet");
    expect(loaded.encryption.daoMinBalance).toBe("100");
    expect(loaded.encryption.keyMetadataPath).toBe("./keys.json");
    expect(loaded.upload.synapsePrivateKey).toBe("0xprivkey");
    expect(loaded.upload.synapseRpcUrl).toBe("https://custom-rpc.example.com");
    expect(loaded.upload.batchSize).toBe(500);
    expect(loaded.upload.registryPath).toBe("./custom-registry.json");
    expect(loaded.libp2p.protocol).toBe("/x/custom");
    expect(loaded.libp2p.ipfsApiUrl).toBe("http://custom-ipfs:5001");
    expect(loaded.cidRecorder.outputDir).toBe("./custom-cids");
  });
});
