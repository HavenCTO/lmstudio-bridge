/**
 * Unit tests for the libp2p listen transport (src/transport/libp2p.ts)
 * All Kubo interactions are mocked — no IPFS daemon needed.
 */

// Mock the ipfs-api module
jest.mock("../../src/utils/ipfs-api", () => ({
  checkDaemonRunning: jest.fn(),
  checkLibp2pStreamMounting: jest.fn(),
  getPeerIdentity: jest.fn(),
  p2pListen: jest.fn(),
  p2pClose: jest.fn(),
  IpfsDaemonNotRunningError: class extends Error {
    constructor(url: string) {
      super(`IPFS daemon not reachable at ${url}`);
      this.name = "IpfsDaemonNotRunningError";
    }
  },
}));

// Mock the HTTP transport
jest.mock("../../src/transport/http", () => ({
  createHttpTransport: jest.fn(() => ({
    start: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { createLibp2pTransport } from "../../src/transport/libp2p";
import {
  checkDaemonRunning,
  checkLibp2pStreamMounting,
  getPeerIdentity,
  p2pListen,
  p2pClose,
} from "../../src/utils/ipfs-api";
import { createHttpTransport } from "../../src/transport/http";

const mockCheckDaemon = checkDaemonRunning as jest.MockedFunction<typeof checkDaemonRunning>;
const mockCheckStream = checkLibp2pStreamMounting as jest.MockedFunction<typeof checkLibp2pStreamMounting>;
const mockGetIdentity = getPeerIdentity as jest.MockedFunction<typeof getPeerIdentity>;
const mockP2pListen = p2pListen as jest.MockedFunction<typeof p2pListen>;
const mockP2pClose = p2pClose as jest.MockedFunction<typeof p2pClose>;

// Minimal Engine mock
const mockEngine = {
  use: jest.fn(),
  handleChatCompletion: jest.fn(),
  healthCheck: jest.fn(),
} as any;

describe("createLibp2pTransport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should start successfully when daemon is running and feature is enabled", async () => {
    mockCheckDaemon.mockResolvedValue(true);
    mockCheckStream.mockResolvedValue(true);
    mockGetIdentity.mockResolvedValue({
      id: "12D3KooWTestPeerID",
      publicKey: "testkey",
      addresses: ["/ip4/127.0.0.1/tcp/4001"],
      agentVersion: "kubo/0.40.0",
    });
    mockP2pListen.mockResolvedValue(undefined);

    const transport = createLibp2pTransport(mockEngine, {
      port: 9999,
      protocol: "/x/llmshim",
      ipfsApiUrl: "http://127.0.0.1:5001",
    });

    await transport.start();

    expect(mockCheckDaemon).toHaveBeenCalledWith({ apiUrl: "http://127.0.0.1:5001" });
    expect(mockCheckStream).toHaveBeenCalledWith({ apiUrl: "http://127.0.0.1:5001" });
    expect(mockGetIdentity).toHaveBeenCalled();
    expect(mockP2pListen).toHaveBeenCalledWith(
      "/x/llmshim",
      "/ip4/127.0.0.1/tcp/9999",
      { apiUrl: "http://127.0.0.1:5001" }
    );
    expect(createHttpTransport).toHaveBeenCalledWith(mockEngine, {
      port: 9999,
      host: "127.0.0.1",
    });
  });

  it("should throw IpfsDaemonNotRunningError when daemon is not running", async () => {
    mockCheckDaemon.mockResolvedValue(false);

    const transport = createLibp2pTransport(mockEngine, {
      port: 9999,
      protocol: "/x/llmshim",
      ipfsApiUrl: "http://127.0.0.1:5001",
    });

    await expect(transport.start()).rejects.toThrow("IPFS daemon not reachable");
  });

  it("should propagate Libp2pStreamMountingDisabledError", async () => {
    mockCheckDaemon.mockResolvedValue(true);
    mockCheckStream.mockRejectedValue(
      new Error("Experimental.Libp2pStreamMounting is not enabled")
    );

    const transport = createLibp2pTransport(mockEngine);
    await expect(transport.start()).rejects.toThrow("Libp2pStreamMounting");
  });

  it("should use default options when none provided", async () => {
    mockCheckDaemon.mockResolvedValue(true);
    mockCheckStream.mockResolvedValue(true);
    mockGetIdentity.mockResolvedValue({
      id: "12D3KooWDefault",
      publicKey: "testkey",
      addresses: [],
      agentVersion: "kubo/0.40.0",
    });
    mockP2pListen.mockResolvedValue(undefined);

    const transport = createLibp2pTransport(mockEngine);
    await transport.start();

    expect(mockCheckDaemon).toHaveBeenCalledWith({ apiUrl: "http://127.0.0.1:5001" });
    expect(mockP2pListen).toHaveBeenCalledWith(
      "/x/llmshim",
      "/ip4/127.0.0.1/tcp/8080",
      { apiUrl: "http://127.0.0.1:5001" }
    );
  });

  describe("shutdown", () => {
    it("should close the p2p tunnel on shutdown", async () => {
      mockCheckDaemon.mockResolvedValue(true);
      mockCheckStream.mockResolvedValue(true);
      mockGetIdentity.mockResolvedValue({
        id: "12D3KooWShutdown",
        publicKey: "testkey",
        addresses: [],
        agentVersion: "kubo/0.40.0",
      });
      mockP2pListen.mockResolvedValue(undefined);
      mockP2pClose.mockResolvedValue(undefined);

      const transport = createLibp2pTransport(mockEngine, {
        port: 9999,
        protocol: "/x/llmshim",
      });
      await transport.start();
      await transport.shutdown();

      expect(mockP2pClose).toHaveBeenCalledWith("/x/llmshim", {
        apiUrl: "http://127.0.0.1:5001",
      });
    });

    it("should be a no-op if not started", async () => {
      const transport = createLibp2pTransport(mockEngine);
      await transport.shutdown(); // should not throw
      expect(mockP2pClose).not.toHaveBeenCalled();
    });

    it("should warn but not throw if p2pClose fails", async () => {
      mockCheckDaemon.mockResolvedValue(true);
      mockCheckStream.mockResolvedValue(true);
      mockGetIdentity.mockResolvedValue({
        id: "12D3KooWFail",
        publicKey: "testkey",
        addresses: [],
        agentVersion: "kubo/0.40.0",
      });
      mockP2pListen.mockResolvedValue(undefined);
      mockP2pClose.mockRejectedValue(new Error("daemon stopped"));

      const transport = createLibp2pTransport(mockEngine);
      await transport.start();
      await transport.shutdown(); // should not throw

      expect(console.warn).toHaveBeenCalled();
    });
  });
});
