/**
 * Unit tests for the client bridge libp2p forward transport.
 * All Kubo interactions are mocked — no IPFS daemon needed.
 */

// Mock the ipfs-api module
jest.mock("../src/utils/ipfs-api", () => ({
  checkDaemonRunning: jest.fn(),
  checkLibp2pStreamMounting: jest.fn(),
  p2pForward: jest.fn(),
  p2pClose: jest.fn(),
  IpfsDaemonNotRunningError: class extends Error {
    constructor(url: string) {
      super(`IPFS daemon not reachable at ${url}`);
      this.name = "IpfsDaemonNotRunningError";
    }
  },
  Libp2pStreamMountingDisabledError: class extends Error {
    constructor() {
      super("Experimental.Libp2pStreamMounting is not enabled");
      this.name = "Libp2pStreamMountingDisabledError";
    }
  },
  PeerIDUnreachableError: class extends Error {
    constructor(peerID: string, timeoutMs: number) {
      super(`PeerID ${peerID} is unreachable (timed out after ${timeoutMs / 1000}s)`);
      this.name = "PeerIDUnreachableError";
    }
  },
  P2PProtocolInUseError: class extends Error {
    constructor(protocol: string) {
      super(`Protocol "${protocol}" is already in use`);
      this.name = "P2PProtocolInUseError";
    }
  },
}));

import {
  checkDaemonRunning,
  checkLibp2pStreamMounting,
  p2pForward,
  p2pClose,
} from "../src/utils/ipfs-api";

const mockCheckDaemon = checkDaemonRunning as jest.MockedFunction<typeof checkDaemonRunning>;
const mockCheckStream = checkLibp2pStreamMounting as jest.MockedFunction<typeof checkLibp2pStreamMounting>;
const mockP2pForward = p2pForward as jest.MockedFunction<typeof p2pForward>;
const mockP2pClose = p2pClose as jest.MockedFunction<typeof p2pClose>;

describe("Client Bridge Libp2p (ipfs-api module)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkDaemonRunning", () => {
    it("should be callable and return mocked value", async () => {
      mockCheckDaemon.mockResolvedValue(true);
      const result = await checkDaemonRunning({ apiUrl: "http://127.0.0.1:5001" });
      expect(result).toBe(true);
      expect(mockCheckDaemon).toHaveBeenCalledWith({ apiUrl: "http://127.0.0.1:5001" });
    });

    it("should return false when daemon is down", async () => {
      mockCheckDaemon.mockResolvedValue(false);
      const result = await checkDaemonRunning();
      expect(result).toBe(false);
    });
  });

  describe("checkLibp2pStreamMounting", () => {
    it("should resolve true when enabled", async () => {
      mockCheckStream.mockResolvedValue(true);
      const result = await checkLibp2pStreamMounting();
      expect(result).toBe(true);
    });

    it("should throw when disabled", async () => {
      mockCheckStream.mockRejectedValue(
        new Error("Experimental.Libp2pStreamMounting is not enabled")
      );
      await expect(checkLibp2pStreamMounting()).rejects.toThrow("Libp2pStreamMounting");
    });
  });

  describe("p2pForward", () => {
    it("should create a forward tunnel", async () => {
      mockP2pForward.mockResolvedValue(undefined);
      await p2pForward("/x/llmshim", "/ip4/127.0.0.1/tcp/9191", "12D3KooWTest");
      expect(mockP2pForward).toHaveBeenCalledWith(
        "/x/llmshim",
        "/ip4/127.0.0.1/tcp/9191",
        "12D3KooWTest"
      );
    });

    it("should throw P2PProtocolInUseError on conflict", async () => {
      mockP2pForward.mockRejectedValue(
        new Error('Protocol "/x/llmshim" is already in use')
      );
      await expect(
        p2pForward("/x/llmshim", "/ip4/127.0.0.1/tcp/9191", "12D3KooWTest")
      ).rejects.toThrow("already in use");
    });
  });

  describe("p2pClose", () => {
    it("should close a tunnel by protocol", async () => {
      mockP2pClose.mockResolvedValue(undefined);
      await p2pClose("/x/llmshim");
      expect(mockP2pClose).toHaveBeenCalledWith("/x/llmshim");
    });
  });
});
