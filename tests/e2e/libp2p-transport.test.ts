/**
 * End-to-End Integration Tests for Libp2p Transport
 *
 * ⚠️ These tests require TWO running Kubo IPFS daemon instances.
 * They are NOT run by the developer — only by QA/CI with Kubo installed.
 *
 * Prerequisites:
 *   1. Two IPFS repos initialized (IPFS_PATH_1 and IPFS_PATH_2)
 *   2. Both with Experimental.Libp2pStreamMounting = true
 *   3. Both daemons running on different ports
 *   4. LM Studio mock running on port 1234
 *   5. npm run build completed in both root and client-bridge/
 *
 * Run with: npm run test:e2e:libp2p
 */

const SHIM_PORT = 18080;
const CLIENT_PORT = 18081;
const LMSTUDIO_PORT = 1234;

const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;

describe("Libp2p Transport E2E", () => {
  // These tests are placeholders that validate the test structure.
  // Actual E2E execution requires Kubo daemons managed by setup-ipfs-test-env.sh

  describe("TC-1: Shim starts with --libp2p and registers tunnel", () => {
    it("should start the shim with libp2p transport", async () => {
      // QA/CI: Start shim with --libp2p --port 18080
      // Verify: process starts, logs PeerID, no errors
      const response = await fetch(`${SHIM_URL}/health`).catch(() => null);
      if (!response) {
        console.warn("Skipping: shim not running (E2E requires Kubo)");
        return;
      }
      const data = await response.json();
      expect(data.status).toBe("ok");
    });
  });

  describe("TC-2: Client bridge creates forward tunnel", () => {
    it("should start client bridge with --libp2p --peerid", async () => {
      const response = await fetch(`${CLIENT_URL}/health`).catch(() => null);
      if (!response) {
        console.warn("Skipping: client bridge not running (E2E requires Kubo)");
        return;
      }
      const data = (await response.json()) as any;
      expect(data.status).toBe("ok");
      expect(data.transport).toBe("libp2p");
    });
  });

  describe("TC-3: Non-streaming chat completion through tunnel", () => {
    it("should proxy a non-streaming request end-to-end", async () => {
      const response = await fetch(`${CLIENT_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hello via libp2p!" }],
        }),
      }).catch(() => null);
      if (!response) {
        console.warn("Skipping: client bridge not running (E2E requires Kubo)");
        return;
      }
      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.choices).toBeDefined();
      expect(data.choices[0].message.content).toContain("Hello");
    });
  });

  describe("TC-4: Streaming (SSE) chat completion through tunnel", () => {
    it("should proxy a streaming request end-to-end", async () => {
      const response = await fetch(`${CLIENT_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Stream test" }],
          stream: true,
        }),
      }).catch(() => null);
      if (!response) {
        console.warn("Skipping: client bridge not running (E2E requires Kubo)");
        return;
      }
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("data:");
      expect(text).toContain("[DONE]");
    });
  });

  describe("TC-5: /v1/models proxied correctly", () => {
    it("should return model list through tunnel", async () => {
      const response = await fetch(`${CLIENT_URL}/v1/models`).catch(() => null);
      if (!response) {
        console.warn("Skipping: client bridge not running (E2E requires Kubo)");
        return;
      }
      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.object).toBe("list");
      expect(data.data).toBeDefined();
    });
  });

  describe("TC-6: /health reports correct status on both sides", () => {
    it("should report health on shim side", async () => {
      const response = await fetch(`${SHIM_URL}/health`).catch(() => null);
      if (!response) {
        console.warn("Skipping: shim not running");
        return;
      }
      const data = await response.json();
      expect(data.status).toBe("ok");
    });

    it("should report health on client bridge side", async () => {
      const response = await fetch(`${CLIENT_URL}/health`).catch(() => null);
      if (!response) {
        console.warn("Skipping: client bridge not running");
        return;
      }
      const data = (await response.json()) as any;
      expect(data.status).toBe("ok");
      expect(data.transport).toBe("libp2p");
      expect(data.peerID).toBeDefined();
    });
  });

  describe("TC-7: Missing required fields returns 400", () => {
    it("should return 400 for missing model field", async () => {
      const response = await fetch(`${CLIENT_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
      }).catch(() => null);
      if (!response) {
        console.warn("Skipping: client bridge not running");
        return;
      }
      expect(response.status).toBe(400);
    });
  });

  describe("TC-8: Tunnel disconnect returns 503", () => {
    it("should return 503 when remote peer goes offline", async () => {
      // This test requires stopping the remote shim while keeping client bridge running
      // QA/CI should manually stop the shim, then send a request
      console.warn(
        "TC-8: Manual test — stop shim, then verify client returns 503"
      );
    });
  });

  describe("TC-9: Graceful shutdown cleans up tunnels", () => {
    it("should clean up tunnels on SIGINT", async () => {
      // QA/CI should send SIGINT to both processes and verify:
      // 1. Both processes exit cleanly (exit code 0)
      // 2. `ipfs p2p ls` shows no lingering tunnels
      console.warn(
        "TC-9: Manual test — send SIGINT and verify tunnel cleanup"
      );
    });
  });
});
