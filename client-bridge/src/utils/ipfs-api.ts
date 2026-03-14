/**
 * IPFS Daemon HTTP API Client Utility (Client Bridge copy)
 *
 * Provides typed helper functions for interacting with the Kubo HTTP RPC API.
 * All interaction happens via HTTP fetch() — never shells out to ipfs CLI.
 *
 * This is a copy of src/utils/ipfs-api.ts for the client bridge package.
 */

// ── Error Types ──

export class IpfsDaemonNotRunningError extends Error {
  constructor(apiUrl: string) {
    super(
      `IPFS daemon not reachable at ${apiUrl}. Is Kubo running? Start with: ipfs daemon`
    );
    this.name = "IpfsDaemonNotRunningError";
  }
}

export class Libp2pStreamMountingDisabledError extends Error {
  constructor() {
    super(
      "Experimental.Libp2pStreamMounting is not enabled.\n" +
        "Enable it with: ipfs config --json Experimental.Libp2pStreamMounting true\n" +
        "Then restart the IPFS daemon."
    );
    this.name = "Libp2pStreamMountingDisabledError";
  }
}

export class P2PProtocolInUseError extends Error {
  constructor(protocol: string) {
    super(
      `Protocol "${protocol}" is already in use. Close it first with: ipfs p2p close --protocol-id ${protocol}`
    );
    this.name = "P2PProtocolInUseError";
  }
}

export class PeerIDUnreachableError extends Error {
  constructor(peerID: string, timeoutMs: number) {
    super(
      `PeerID ${peerID} is unreachable (timed out after ${timeoutMs / 1000}s)\n\n` +
        `Possible causes:\n` +
        `  • The remote shim is not running with --libp2p\n` +
        `  • The remote IPFS daemon is offline\n` +
        `  • NAT traversal failed (both peers behind symmetric NAT)\n\n` +
        `Troubleshooting:\n` +
        `  1. Verify the PeerID is correct\n` +
        `  2. Test IPFS connectivity: ipfs swarm connect /p2p/${peerID}\n` +
        `  3. Check tunnel on remote: ipfs p2p ls`
    );
    this.name = "PeerIDUnreachableError";
  }
}

export class IpfsApiUrlError extends Error {
  constructor(apiUrl: string, cause?: string) {
    super(
      `Could not connect to IPFS API at ${apiUrl}\n\n` +
        (cause ? `Cause: ${cause}\n\n` : "") +
        `Check your daemon's API address:\n` +
        `  $ ipfs config Addresses.API\n\n` +
        `Then pass it explicitly:\n` +
        `  $ --ipfs-api-url http://<host>:<port>`
    );
    this.name = "IpfsApiUrlError";
  }
}

// ── Interfaces ──

export interface IpfsApiOptions {
  apiUrl?: string;
  timeoutMs?: number;
}

export interface PeerIdentity {
  id: string;
  publicKey: string;
  addresses: string[];
  agentVersion: string;
}

export interface P2PTunnel {
  protocol: string;
  listenAddress: string;
  targetAddress: string;
}

// ── Default Options ──

const DEFAULT_API_URL = "http://127.0.0.1:5001";
const DEFAULT_TIMEOUT_MS = 5000;

function resolveOptions(opts?: IpfsApiOptions): {
  apiUrl: string;
  timeoutMs: number;
} {
  return {
    apiUrl: opts?.apiUrl ?? DEFAULT_API_URL,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

// ── API Functions ──

export async function checkDaemonRunning(
  opts?: IpfsApiOptions
): Promise<boolean> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  try {
    const response = await fetch(`${apiUrl}/api/v0/id`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getPeerID(opts?: IpfsApiOptions): Promise<string> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v0/id`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  if (!response.ok) {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new IpfsApiUrlError(apiUrl, "Response was not valid JSON");
  }

  if (!data.ID) {
    throw new IpfsApiUrlError(apiUrl, "Response did not contain an ID field");
  }

  return data.ID;
}

export async function checkLibp2pStreamMounting(
  opts?: IpfsApiOptions
): Promise<boolean> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v0/config/show`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  if (!response.ok) {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new IpfsApiUrlError(apiUrl, "Config response was not valid JSON");
  }

  const enabled = data?.Experimental?.Libp2pStreamMounting === true;
  if (!enabled) {
    throw new Libp2pStreamMountingDisabledError();
  }

  return true;
}

export async function p2pListen(
  protocol: string,
  targetAddr: string,
  opts?: IpfsApiOptions
): Promise<void> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  const params = new URLSearchParams();
  params.append("arg", protocol);
  params.append("arg", targetAddr);

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v0/p2p/listen?${params.toString()}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (
      text.toLowerCase().includes("already active") ||
      text.toLowerCase().includes("protocol handler already registered")
    ) {
      throw new P2PProtocolInUseError(protocol);
    }
    throw new Error(`p2pListen failed: ${response.status} ${text}`);
  }
}

export async function p2pForward(
  protocol: string,
  listenAddr: string,
  targetPeerID: string,
  opts?: IpfsApiOptions
): Promise<void> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  const params = new URLSearchParams();
  params.append("arg", protocol);
  params.append("arg", listenAddr);
  params.append("arg", `/p2p/${targetPeerID}`);

  let response: Response;
  try {
    response = await fetch(
      `${apiUrl}/api/v0/p2p/forward?${params.toString()}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (
      text.toLowerCase().includes("already active") ||
      text.toLowerCase().includes("protocol handler already registered")
    ) {
      throw new P2PProtocolInUseError(protocol);
    }
    throw new Error(`p2pForward failed: ${response.status} ${text}`);
  }
}

export async function p2pClose(
  protocol?: string,
  opts?: IpfsApiOptions
): Promise<void> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  const params = new URLSearchParams();
  if (protocol) {
    params.append("protocol-id", protocol);
  } else {
    params.append("all", "true");
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v0/p2p/close?${params.toString()}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`p2pClose failed: ${response.status} ${text}`);
  }
}

export async function p2pList(opts?: IpfsApiOptions): Promise<P2PTunnel[]> {
  const { apiUrl, timeoutMs } = resolveOptions(opts);
  const params = new URLSearchParams();
  params.append("headers", "true");

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v0/p2p/ls?${params.toString()}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IpfsDaemonNotRunningError(apiUrl);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`p2pList failed: ${response.status} ${text}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new IpfsApiUrlError(apiUrl, "p2p ls response was not valid JSON");
  }

  const listeners = data?.Listeners ?? [];
  return listeners.map((entry: any) => ({
    protocol: entry.Protocol ?? "",
    listenAddress: entry.ListenAddress ?? "",
    targetAddress: entry.TargetAddress ?? "",
  }));
}
