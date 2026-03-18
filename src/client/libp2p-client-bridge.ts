/**
 * Libp2p forward transport + HTTP proxy for the client bridge.
 *
 * 1. Verifies IPFS daemon is running (via HTTP RPC)
 * 2. Verifies Libp2pStreamMounting is enabled (via HTTP RPC)
 * 3. Creates a p2p forward tunnel to the remote PeerID (via HTTP RPC)
 * 4. Waits for the tunnel to be ready (TCP connectivity check)
 * 5. Starts a local HTTP proxy that forwards requests through the tunnel
 *
 * All Kubo interaction uses fetch() via the shared ipfs-api utility.
 * The middleware pipeline is fully preserved on the remote shim side.
 */

import * as net from "net";
import express, { Request, Response } from "express";
import {
  checkDaemonRunning,
  checkLibp2pStreamMounting,
  p2pForward,
  p2pClose,
  IpfsDaemonNotRunningError,
  PeerIDUnreachableError,
} from "../utils/ipfs-api.js";

export interface Libp2pClientBridgeOptions {
  /** Remote shim's PeerID */
  peerID: string;
  /** Libp2p protocol name */
  protocol: string;
  /** Local port for the tunnel endpoint (fixed port for the forward tunnel) */
  tunnelPort: number;
  /** Port for the local OpenAI-compatible HTTP server */
  proxyPort: number;
  /** Host for the local HTTP server */
  proxyHost: string;
  /** Kubo HTTP RPC API URL */
  ipfsApiUrl: string;
  /** Request timeout in ms */
  timeoutMs: number;
}

/**
 * Wait for a TCP port to become reachable, with backoff retries.
 */
async function waitForTunnel(
  host: string,
  port: number,
  maxWaitMs: number = 10000
): Promise<boolean> {
  const startTime = Date.now();
  let delay = 500;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host, port }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 3000);
    }
  }
  return false;
}

export function createLibp2pClientBridge(
  options: Libp2pClientBridgeOptions
): { start: () => Promise<void>; shutdown: () => Promise<void> } {
  let registeredProtocol: string | null = null;
  let httpServer: ReturnType<typeof net.Server.prototype.listen> | null = null;
  // The actual tunnel port (resolved after p2pForward if auto-assigned)
  let resolvedTunnelPort: number = options.tunnelPort || 9191;

  const start = async (): Promise<void> => {
    const apiOpts = { apiUrl: options.ipfsApiUrl };

    // 1. Verify IPFS daemon is running
    console.log(
      `[libp2p-client] verifying IPFS daemon at ${options.ipfsApiUrl}...`
    );
    const running = await checkDaemonRunning(apiOpts);
    if (!running) {
      throw new IpfsDaemonNotRunningError(options.ipfsApiUrl);
    }
    console.log(`[libp2p-client] ✓ IPFS daemon running`);

    // 2. Verify Libp2pStreamMounting is enabled
    await checkLibp2pStreamMounting(apiOpts);
    console.log(`[libp2p-client] ✓ Libp2pStreamMounting enabled`);

    // 3. Create p2p forward tunnel via HTTP RPC
    if (options.tunnelPort === 0) {
      resolvedTunnelPort = 9191;
    } else {
      resolvedTunnelPort = options.tunnelPort;
    }

    const listenAddr = `/ip4/127.0.0.1/tcp/${resolvedTunnelPort}`;
    console.log(
      `[libp2p-client] creating tunnel to PeerID: ${options.peerID}`
    );
    await p2pForward(
      options.protocol,
      listenAddr,
      options.peerID,
      apiOpts
    );
    registeredProtocol = options.protocol;
    console.log(
      `[libp2p-client] ✓ tunnel established: ${options.protocol} → 127.0.0.1:${resolvedTunnelPort} → /p2p/${options.peerID}`
    );

    // 4. Wait for tunnel connectivity
    console.log(`[libp2p-client] waiting for tunnel connectivity...`);
    const reachable = await waitForTunnel(
      "127.0.0.1",
      resolvedTunnelPort,
      options.timeoutMs || 10000
    );
    if (!reachable) {
      throw new PeerIDUnreachableError(
        options.peerID,
        options.timeoutMs || 10000
      );
    }
    console.log(`[libp2p-client] ✓ tunnel reachable`);

    // 5. Start local HTTP proxy server
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    // Health endpoint
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        mode: "client",
        transport: "libp2p",
        peerID: options.peerID,
        protocol: options.protocol,
        tunnelPort: resolvedTunnelPort,
      });
    });

    // OpenAI-compatible Chat Completions — proxy to tunnel
    app.post(
      "/v1/chat/completions",
      async (req: Request, res: Response) => {
        try {
          const body = req.body;

          if (!body.model || !body.messages) {
            res.status(400).json({
              error: {
                message: "Missing required fields: model, messages",
                type: "invalid_request_error",
                code: "missing_required_fields",
              },
            });
            return;
          }

          const tunnelUrl = `http://127.0.0.1:${resolvedTunnelPort}/v1/chat/completions`;

          let upstream: globalThis.Response;
          try {
            upstream = await fetch(tunnelUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
          } catch (err) {
            console.warn(
              `[libp2p-client] ⚠ tunnel connection lost — request failed: ${err instanceof Error ? err.message : err}`
            );
            console.warn(
              `[libp2p-client] ⚠ the remote peer may have gone offline`
            );
            res.status(503).json({
              error: {
                message:
                  "Tunnel to remote shim is unavailable. The remote peer may be offline.",
                type: "server_error",
                code: "tunnel_unavailable",
              },
            });
            return;
          }

          // For streaming: pipe the response
          if (body.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            if (upstream.body) {
              const reader = (upstream.body as any).getReader
                ? (upstream.body as any).getReader()
                : null;

              if (reader) {
                const decoder = new TextDecoder();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(decoder.decode(value, { stream: true }));
                  }
                } catch {
                  // Stream ended
                } finally {
                  res.end();
                }
              } else {
                // Fallback: read text and send
                const text = await upstream.text();
                res.write(text);
                res.end();
              }
            } else {
              const text = await upstream.text();
              res.write(text);
              res.end();
            }
          } else {
            const data = await upstream.json();
            res.status(upstream.status).json(data);
          }
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : "Unknown error";
          console.error(`[libp2p-client] proxy error:`, err);
          res.status(502).json({
            error: {
              message: `Libp2p proxy error: ${message}`,
              type: "server_error",
              code: "proxy_error",
            },
          });
        }
      }
    );

    // Models list — proxy to tunnel
    app.get("/v1/models", async (_req: Request, res: Response) => {
      try {
        const tunnelUrl = `http://127.0.0.1:${resolvedTunnelPort}/v1/models`;
        const upstream = await fetch(tunnelUrl, { method: "GET" });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        res.status(502).json({
          error: {
            message: `Libp2p proxy error: ${message}`,
            type: "server_error",
            code: "proxy_error",
          },
        });
      }
    });

    // Start the proxy server
    await new Promise<void>((resolve) => {
      httpServer = app.listen(
        options.proxyPort,
        options.proxyHost,
        () => {
          console.log();
          console.log(`[client] ✓ local OpenAI-compatible API available at:`);
          console.log(
            `[client]   POST http://${options.proxyHost}:${options.proxyPort}/v1/chat/completions`
          );
          console.log(
            `[client]   GET  http://${options.proxyHost}:${options.proxyPort}/v1/models`
          );
          console.log(
            `[client]   GET  http://${options.proxyHost}:${options.proxyPort}/health`
          );
          console.log();
          console.log(`[client] client bridge is ready! (transport: libp2p)`);
          resolve();
        }
      ) as any;

      // Disable timeouts for long-running LLM requests
      const server = httpServer as any;
      if (server) {
        server.timeout = 0;
        server.keepAliveTimeout = 0;
        server.headersTimeout = 0;
        if ("requestTimeout" in server) {
          server.requestTimeout = 0;
        }
      }
    });
  };

  const shutdown = async (): Promise<void> => {
    // 1. Close the local HTTP proxy server
    if (httpServer) {
      await new Promise<void>((resolve) => {
        (httpServer as any).close(() => resolve());
      });
      console.log(`[libp2p-client] ✓ local HTTP proxy closed`);
      httpServer = null;
    }

    // 2. Close the p2p forward tunnel (via HTTP RPC, not CLI)
    if (registeredProtocol) {
      try {
        console.log(
          `[libp2p-client] closing p2p tunnel for ${registeredProtocol}...`
        );
        await p2pClose(registeredProtocol, { apiUrl: options.ipfsApiUrl });
        console.log(`[libp2p-client] ✓ tunnel closed`);
      } catch (err) {
        console.warn(
          `[libp2p-client] tunnel cleanup warning: ${err instanceof Error ? err.message : err}`
        );
      }
      registeredProtocol = null;
    }
  };

  return { start, shutdown };
}
