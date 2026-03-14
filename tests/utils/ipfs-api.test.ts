/**
 * Unit tests for IPFS Daemon HTTP API Client Utility.
 * All tests use mocked global.fetch — no IPFS daemon or Kubo binary required.
 */

import {
  checkDaemonRunning,
  getPeerID,
  getPeerIdentity,
  checkLibp2pStreamMounting,
  p2pListen,
  p2pForward,
  p2pClose,
  p2pList,
  IpfsDaemonNotRunningError,
  Libp2pStreamMountingDisabledError,
  P2PProtocolInUseError,
  IpfsApiUrlError,
  PeerIDUnreachableError,
} from "../../src/utils/ipfs-api";

// ── Mock fetch ──

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ── Helper to create a mock Response ──

function mockResponse(
  body: any,
  status: number = 200,
  ok: boolean = true
): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    statusText: status === 200 ? "OK" : "Error",
    type: "basic" as any,
    url: "",
    clone: () => mockResponse(body, status, ok),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bytes: async () => new Uint8Array(),
  } as Response;
}

// ── checkDaemonRunning ──

describe("checkDaemonRunning", () => {
  it("returns true when daemon responds with 200", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ID: "12D3KooWExAmPlE" })
    );
    const result = await checkDaemonRunning({
      apiUrl: "http://127.0.0.1:5001",
    });
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5001/api/v0/id",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns false on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await checkDaemonRunning({
      apiUrl: "http://127.0.0.1:5001",
    });
    expect(result).toBe(false);
  });

  it("returns false on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 500, false));
    const result = await checkDaemonRunning({
      apiUrl: "http://127.0.0.1:5001",
    });
    expect(result).toBe(false);
  });

  it("uses default apiUrl when none provided", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ID: "12D3KooWExAmPlE" })
    );
    await checkDaemonRunning();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5001/api/v0/id",
      expect.anything()
    );
  });
});

// ── getPeerID ──

describe("getPeerID", () => {
  it("returns PeerID string from /api/v0/id response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ID: "12D3KooWExAmPlE",
        PublicKey: "CAESIPublicKey",
        Addresses: ["/ip4/127.0.0.1/tcp/4001"],
        AgentVersion: "kubo/0.40.0",
      })
    );
    const peerID = await getPeerID({ apiUrl: "http://127.0.0.1:5001" });
    expect(peerID).toBe("12D3KooWExAmPlE");
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      getPeerID({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });

  it("throws IpfsDaemonNotRunningError on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 500, false));
    await expect(
      getPeerID({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });

  it("throws IpfsApiUrlError when response is not valid JSON", async () => {
    const badResp = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
      text: async () => "not json",
    } as unknown as Response;
    mockFetch.mockResolvedValueOnce(badResp);
    await expect(
      getPeerID({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsApiUrlError);
  });
});

// ── getPeerIdentity ──

describe("getPeerIdentity", () => {
  it("returns full peer identity", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ID: "12D3KooWExAmPlE",
        PublicKey: "CAESIPublicKey",
        Addresses: ["/ip4/127.0.0.1/tcp/4001"],
        AgentVersion: "kubo/0.40.0",
      })
    );
    const identity = await getPeerIdentity({
      apiUrl: "http://127.0.0.1:5001",
    });
    expect(identity.id).toBe("12D3KooWExAmPlE");
    expect(identity.publicKey).toBe("CAESIPublicKey");
    expect(identity.addresses).toEqual(["/ip4/127.0.0.1/tcp/4001"]);
    expect(identity.agentVersion).toBe("kubo/0.40.0");
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      getPeerIdentity({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });
});

// ── checkLibp2pStreamMounting ──

describe("checkLibp2pStreamMounting", () => {
  it("returns true when Libp2pStreamMounting is enabled", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        Experimental: { Libp2pStreamMounting: true },
      })
    );
    const result = await checkLibp2pStreamMounting({
      apiUrl: "http://127.0.0.1:5001",
    });
    expect(result).toBe(true);
  });

  it("throws Libp2pStreamMountingDisabledError when feature is disabled", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        Experimental: { Libp2pStreamMounting: false },
      })
    );
    await expect(
      checkLibp2pStreamMounting({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(Libp2pStreamMountingDisabledError);
  });

  it("throws Libp2pStreamMountingDisabledError when Experimental section is missing", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}));
    await expect(
      checkLibp2pStreamMounting({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(Libp2pStreamMountingDisabledError);
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      checkLibp2pStreamMounting({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });
});

// ── p2pListen ──

describe("p2pListen", () => {
  it("succeeds on 200 response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}));
    await expect(
      p2pListen("/x/llmshim", "/ip4/127.0.0.1/tcp/8080", {
        apiUrl: "http://127.0.0.1:5001",
      })
    ).resolves.toBeUndefined();

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v0/p2p/listen");
    expect(calledUrl).toContain("arg=%2Fx%2Fllmshim");
    expect(calledUrl).toContain("arg=%2Fip4%2F127.0.0.1%2Ftcp%2F8080");
  });

  it("throws P2PProtocolInUseError when protocol is already registered", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse("protocol handler already registered", 500, false)
    );
    await expect(
      p2pListen("/x/llmshim", "/ip4/127.0.0.1/tcp/8080", {
        apiUrl: "http://127.0.0.1:5001",
      })
    ).rejects.toThrow(P2PProtocolInUseError);
  });

  it("throws P2PProtocolInUseError when already active", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse("already active", 500, false)
    );
    await expect(
      p2pListen("/x/llmshim", "/ip4/127.0.0.1/tcp/8080", {
        apiUrl: "http://127.0.0.1:5001",
      })
    ).rejects.toThrow(P2PProtocolInUseError);
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      p2pListen("/x/llmshim", "/ip4/127.0.0.1/tcp/8080", {
        apiUrl: "http://127.0.0.1:5001",
      })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });

  it("throws generic Error on other non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse("some other error", 500, false)
    );
    await expect(
      p2pListen("/x/llmshim", "/ip4/127.0.0.1/tcp/8080", {
        apiUrl: "http://127.0.0.1:5001",
      })
    ).rejects.toThrow("p2pListen failed");
  });
});

// ── p2pForward ──

describe("p2pForward", () => {
  it("succeeds on 200 response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}));
    await expect(
      p2pForward(
        "/x/llmshim",
        "/ip4/127.0.0.1/tcp/9090",
        "12D3KooWExAmPlE",
        { apiUrl: "http://127.0.0.1:5001" }
      )
    ).resolves.toBeUndefined();

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v0/p2p/forward");
    expect(calledUrl).toContain("arg=%2Fx%2Fllmshim");
    expect(calledUrl).toContain("arg=%2Fp2p%2F12D3KooWExAmPlE");
  });

  it("throws P2PProtocolInUseError on conflict", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse("protocol handler already registered", 500, false)
    );
    await expect(
      p2pForward(
        "/x/llmshim",
        "/ip4/127.0.0.1/tcp/9090",
        "12D3KooWExAmPlE",
        { apiUrl: "http://127.0.0.1:5001" }
      )
    ).rejects.toThrow(P2PProtocolInUseError);
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      p2pForward(
        "/x/llmshim",
        "/ip4/127.0.0.1/tcp/9090",
        "12D3KooWExAmPlE",
        { apiUrl: "http://127.0.0.1:5001" }
      )
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });
});

// ── p2pClose ──

describe("p2pClose", () => {
  it("closes by protocol when protocol is specified", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}));
    await p2pClose("/x/llmshim", { apiUrl: "http://127.0.0.1:5001" });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v0/p2p/close");
    expect(calledUrl).toContain("protocol-id=%2Fx%2Fllmshim");
    expect(calledUrl).not.toContain("all=true");
  });

  it("closes all tunnels when no protocol is specified", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}));
    await p2pClose(undefined, { apiUrl: "http://127.0.0.1:5001" });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v0/p2p/close");
    expect(calledUrl).toContain("all=true");
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      p2pClose("/x/llmshim", { apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });

  it("throws Error on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse("error", 500, false)
    );
    await expect(
      p2pClose("/x/llmshim", { apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow("p2pClose failed");
  });
});

// ── p2pList ──

describe("p2pList", () => {
  it("parses tunnel list from response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        Listeners: [
          {
            Protocol: "/x/llmshim",
            ListenAddress: "/ip4/127.0.0.1/tcp/8080",
            TargetAddress: "/p2p/12D3KooWExAmPlE",
          },
          {
            Protocol: "/x/ssh",
            ListenAddress: "/ip4/127.0.0.1/tcp/2222",
            TargetAddress: "/p2p/12D3KooWOtHeR",
          },
        ],
      })
    );
    const tunnels = await p2pList({ apiUrl: "http://127.0.0.1:5001" });
    expect(tunnels).toHaveLength(2);
    expect(tunnels[0]).toEqual({
      protocol: "/x/llmshim",
      listenAddress: "/ip4/127.0.0.1/tcp/8080",
      targetAddress: "/p2p/12D3KooWExAmPlE",
    });
    expect(tunnels[1]).toEqual({
      protocol: "/x/ssh",
      listenAddress: "/ip4/127.0.0.1/tcp/2222",
      targetAddress: "/p2p/12D3KooWOtHeR",
    });
  });

  it("returns empty array when no listeners", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ Listeners: null }));
    const tunnels = await p2pList({ apiUrl: "http://127.0.0.1:5001" });
    expect(tunnels).toEqual([]);
  });

  it("throws IpfsDaemonNotRunningError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      p2pList({ apiUrl: "http://127.0.0.1:5001" })
    ).rejects.toThrow(IpfsDaemonNotRunningError);
  });
});

// ── Error classes ──

describe("Error classes", () => {
  it("IpfsDaemonNotRunningError has actionable message", () => {
    const err = new IpfsDaemonNotRunningError("http://127.0.0.1:5001");
    expect(err.name).toBe("IpfsDaemonNotRunningError");
    expect(err.message).toContain("ipfs daemon");
    expect(err.message).toContain("http://127.0.0.1:5001");
  });

  it("Libp2pStreamMountingDisabledError has enable command", () => {
    const err = new Libp2pStreamMountingDisabledError();
    expect(err.name).toBe("Libp2pStreamMountingDisabledError");
    expect(err.message).toContain("ipfs config --json Experimental.Libp2pStreamMounting true");
  });

  it("P2PProtocolInUseError has close command", () => {
    const err = new P2PProtocolInUseError("/x/llmshim");
    expect(err.name).toBe("P2PProtocolInUseError");
    expect(err.message).toContain("ipfs p2p close --protocol-id /x/llmshim");
  });

  it("PeerIDUnreachableError has troubleshooting steps", () => {
    const err = new PeerIDUnreachableError("12D3KooWExAmPlE", 30000);
    expect(err.name).toBe("PeerIDUnreachableError");
    expect(err.message).toContain("12D3KooWExAmPlE");
    expect(err.message).toContain("30s");
    expect(err.message).toContain("ipfs swarm connect");
    expect(err.message).toContain("ipfs p2p ls");
  });

  it("IpfsApiUrlError has URL and corrective instructions", () => {
    const err = new IpfsApiUrlError("http://127.0.0.1:5001", "connection refused");
    expect(err.name).toBe("IpfsApiUrlError");
    expect(err.message).toContain("http://127.0.0.1:5001");
    expect(err.message).toContain("connection refused");
    expect(err.message).toContain("ipfs config Addresses.API");
  });
});
