/**
 * Libp2p listen transport — thin wrapper around the HTTP transport.
 *
 * 1. Verifies IPFS daemon is running (via HTTP RPC)
 * 2. Verifies Libp2pStreamMounting is enabled (via HTTP RPC)
 * 3. Gets and logs the local PeerID (via HTTP RPC)
 * 4. Starts the standard HTTP transport on 127.0.0.1 (localhost only)
 * 5. Registers a p2p listener via HTTP RPC (protocol → local HTTP server)
 *
 * All Kubo interaction uses fetch() via ipfs-api.ts — never shells out to ipfs CLI.
 * The middleware pipeline is fully preserved: the HTTP transport calls
 * engine.handleChatCompletion() which runs the full middleware chain.
 */

import { Engine } from "../pipeline/engine.js";
import { createHttpTransport } from "./http.js";
import {
  checkDaemonRunning,
  checkLibp2pStreamMounting,
  getPeerIdentity,
  p2pListen,
  p2pClose,
  IpfsDaemonNotRunningError,
} from "../utils/ipfs-api.js";

export interface Libp2pTransportOptions {
  /** Port for the local HTTP server that the tunnel forwards to */
  port: number;
  /** Libp2p protocol name (e.g., /x/llmshim) */
  protocol: string;
  /** Kubo HTTP RPC API URL */
  ipfsApiUrl: string;
}

const DEFAULTS: Libp2pTransportOptions = {
  port: 8080,
  protocol: "/x/llmshim",
  ipfsApiUrl: "http://127.0.0.1:5001",
};

export function createLibp2pTransport(
  engine: Engine,
  options?: Partial<Libp2pTransportOptions>
): { start: () => Promise<void>; shutdown: () => Promise<void> } {
  const opts = { ...DEFAULTS, ...options };
  let registeredProtocol: string | null = null;

  const start = async (): Promise<void> => {
    const apiOpts = { apiUrl: opts.ipfsApiUrl };

    // 1. Verify IPFS daemon is running
    console.log(
      `[libp2p] verifying IPFS daemon at ${opts.ipfsApiUrl}...`
    );
    const running = await checkDaemonRunning(apiOpts);
    if (!running) {
      throw new IpfsDaemonNotRunningError(opts.ipfsApiUrl);
    }
    console.log(`[libp2p] ✓ IPFS daemon running`);

    // 2. Verify Libp2pStreamMounting is enabled
    await checkLibp2pStreamMounting(apiOpts);
    console.log(`[libp2p] ✓ Libp2pStreamMounting enabled`);

    // 3. Get and log PeerID
    const identity = await getPeerIdentity(apiOpts);
    const peerID = identity.id;
    console.log(`[libp2p] local PeerID: ${peerID}`);

    // 4. Start the HTTP transport on localhost only (security: no external binding)
    console.log(
      `[libp2p] starting HTTP transport on 127.0.0.1:${opts.port}...`
    );
    const http = createHttpTransport(engine, {
      port: opts.port,
      host: "127.0.0.1",
    });
    await http.start();

    // 5. Register p2p listener via HTTP RPC
    const targetAddr = `/ip4/127.0.0.1/tcp/${opts.port}`;
    console.log(
      `[libp2p] registering p2p listener: ${opts.protocol} → ${targetAddr}`
    );
    await p2pListen(opts.protocol, targetAddr, apiOpts);
    registeredProtocol = opts.protocol;
    console.log(`[libp2p] ✓ tunnel active`);

    // 6. Log connection instructions
    console.log(`[libp2p]`);
    console.log(
      `[libp2p] ═══════════════════════════════════════════════════`
    );
    console.log(`[libp2p]  Clients can connect with:`);
    console.log(`[libp2p]    --libp2p --peerid ${peerID}`);
    console.log(
      `[libp2p] ═══════════════════════════════════════════════════`
    );
  };

  const shutdown = async (): Promise<void> => {
    if (!registeredProtocol) return;

    try {
      console.log(
        `[libp2p] closing p2p tunnel for ${registeredProtocol}...`
      );
      await p2pClose(registeredProtocol, { apiUrl: opts.ipfsApiUrl });
      console.log(`[libp2p] ✓ tunnel closed`);
    } catch (err) {
      // Non-fatal — daemon may have already stopped
      console.warn(
        `[libp2p] tunnel cleanup warning: ${err instanceof Error ? err.message : err}`
      );
    }
    registeredProtocol = null;
  };

  return { start, shutdown };
}
