/**
 * Unit tests for libp2p error classes (S2-T4)
 * Verifies all error types produce actionable, user-friendly messages.
 */

import {
  IpfsDaemonNotRunningError,
  Libp2pStreamMountingDisabledError,
  P2PProtocolInUseError,
  PeerIDUnreachableError,
  IpfsApiUrlError,
} from "../src/utils/ipfs-api";

describe("Libp2p Error Classes", () => {
  describe("IpfsDaemonNotRunningError", () => {
    it("should include the API URL and fix command", () => {
      const err = new IpfsDaemonNotRunningError("http://127.0.0.1:5001");
      expect(err.name).toBe("IpfsDaemonNotRunningError");
      expect(err.message).toContain("http://127.0.0.1:5001");
      expect(err.message).toContain("ipfs daemon");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("Libp2pStreamMountingDisabledError", () => {
    it("should include the enable command", () => {
      const err = new Libp2pStreamMountingDisabledError();
      expect(err.name).toBe("Libp2pStreamMountingDisabledError");
      expect(err.message).toContain("Libp2pStreamMounting");
      expect(err.message).toContain(
        "ipfs config --json Experimental.Libp2pStreamMounting true"
      );
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("P2PProtocolInUseError", () => {
    it("should include the protocol name and close command", () => {
      const err = new P2PProtocolInUseError("/x/llmshim");
      expect(err.name).toBe("P2PProtocolInUseError");
      expect(err.message).toContain("/x/llmshim");
      expect(err.message).toContain("ipfs p2p close");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("PeerIDUnreachableError", () => {
    it("should include the PeerID, timeout, and troubleshooting steps", () => {
      const err = new PeerIDUnreachableError("12D3KooWTest", 10000);
      expect(err.name).toBe("PeerIDUnreachableError");
      expect(err.message).toContain("12D3KooWTest");
      expect(err.message).toContain("10s");
      expect(err.message).toContain("Troubleshooting");
      expect(err.message).toContain("ipfs swarm connect");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("IpfsApiUrlError", () => {
    it("should include the URL and diagnostic steps", () => {
      const err = new IpfsApiUrlError("http://127.0.0.1:5001");
      expect(err.name).toBe("IpfsApiUrlError");
      expect(err.message).toContain("http://127.0.0.1:5001");
      expect(err.message).toContain("ipfs config Addresses.API");
      expect(err).toBeInstanceOf(Error);
    });

    it("should include optional cause when provided", () => {
      const err = new IpfsApiUrlError(
        "http://localhost:9999",
        "Connection refused"
      );
      expect(err.message).toContain("Connection refused");
      expect(err.message).toContain("localhost:9999");
    });
  });

  describe("Error messages contain no stack traces for end users", () => {
    it("all errors should have clean message strings", () => {
      const errors = [
        new IpfsDaemonNotRunningError("http://127.0.0.1:5001"),
        new Libp2pStreamMountingDisabledError(),
        new P2PProtocolInUseError("/x/llmshim"),
        new PeerIDUnreachableError("12D3KooWTest", 10000),
        new IpfsApiUrlError("http://127.0.0.1:5001"),
      ];

      for (const err of errors) {
        // Messages should not contain "at " (stack trace lines)
        expect(err.message).not.toMatch(/^\s+at /m);
        // Messages should be non-empty
        expect(err.message.length).toBeGreaterThan(10);
      }
    });
  });
});
