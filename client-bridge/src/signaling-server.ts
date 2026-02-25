/**
 * Ephemeral HTTP signaling server for WebRTC pairing.
 *
 *   - GET /offer  → returns the SDP offer (with bundled ICE candidates)
 *   - POST /answer → accepts the SDP answer (single-use)
 *   - Bearer token authentication on all endpoints
 *   - 60-second hard timeout
 *   - Shuts down after answer is received or timeout fires
 */

import * as http from "http";
import { SIGNALING_TIMEOUT_MS } from "./protocol";

export interface SignalingServerOptions {
  /** Port for the ephemeral signaling server (0 = random) */
  port: number;
  /** Bearer token for authentication */
  token: string;
  /** Host to bind to */
  host: string;
}

export interface SignalingServer {
  /** Start the server and return the actual port */
  start: () => Promise<number>;
  /** Set the SDP offer (call after ICE gathering is complete) */
  setOffer: (sdp: string) => void;
  /** Wait for the answer to be submitted. Resolves with the SDP answer string. */
  waitForAnswer: () => Promise<string>;
  /** Shut down the server */
  stop: () => Promise<void>;
}

export function createSignalingServer(
  options: SignalingServerOptions
): SignalingServer {
  let offerSdp: string | null = null;
  let answerConsumed = false;
  let answerResolve: ((sdp: string) => void) | null = null;
  let answerReject: ((err: Error) => void) | null = null;
  let server: http.Server | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const setOffer = (sdp: string): void => {
    offerSdp = sdp;
    console.log(`[signaling] SDP offer ready to serve`);
  };

  const waitForAnswer = (): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      answerResolve = resolve;
      answerReject = reject;
    });
  };

  const stop = async (): Promise<void> => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (server) {
      return new Promise<void>((resolve) => {
        server!.close(() => {
          console.log(`[signaling] server shut down`);
          server = null;
          resolve();
        });
      });
    }
  };

  const start = (): Promise<number> => {
    return new Promise<number>((resolve, reject) => {
      server = http.createServer((req, res) => {
        // ── Auth check ──
        const authHeader = req.headers["authorization"];
        const bearerToken = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : null;

        if (bearerToken !== options.token) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }

        // ── GET /offer ──
        if (req.method === "GET" && req.url === "/offer") {
          if (!offerSdp) {
            res.writeHead(503, { "Content-Type": "text/plain" });
            res.end("Not ready");
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ offer: offerSdp }));
          return;
        }

        // ── POST /answer ──
        if (req.method === "POST" && req.url === "/answer") {
          if (answerConsumed) {
            res.writeHead(409, { "Content-Type": "text/plain" });
            res.end("Answer already submitted");
            return;
          }

          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
            // Limit body size to 64 KB
            if (body.length > 65536) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Request too large");
              req.destroy();
            }
          });

          req.on("end", () => {
            try {
              const parsed = JSON.parse(body) as { answer?: string };
              if (!parsed.answer || typeof parsed.answer !== "string") {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Missing or invalid 'answer' field");
                return;
              }

              answerConsumed = true;
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end("OK");

              console.log(`[signaling] answer received, shutting down signaling server`);

              // Resolve the answer promise
              if (answerResolve) {
                answerResolve(parsed.answer);
              }

              // Shut down immediately (don't wait for timeout)
              stop().catch(() => {});
            } catch {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid JSON");
            }
          });
          return;
        }

        // ── Unknown endpoint ──
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      });

      server.listen(options.port, options.host, () => {
        const addr = server!.address();
        const actualPort =
          typeof addr === "object" && addr ? addr.port : options.port;
        console.log(
          `[signaling] ephemeral server on http://${options.host}:${actualPort}`
        );

        // Start 60-second hard timeout
        timeoutTimer = setTimeout(() => {
          console.log(`[signaling] timeout reached (${SIGNALING_TIMEOUT_MS}ms), shutting down`);
          if (answerReject && !answerConsumed) {
            answerReject(new Error("Signaling timeout: no answer received within 60 seconds"));
          }
          stop().catch(() => {});
        }, SIGNALING_TIMEOUT_MS);

        resolve(actualPort);
      });

      server.on("error", (err) => {
        reject(err);
      });
    });
  };

  return { start, setOffer, waitForAnswer, stop };
}