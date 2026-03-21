/**
 * QR-code based WebRTC signaling for LAN.
 *
 * No HTTP signaling server needed. SDP offers/answers are exchanged
 * manually via QR codes displayed in terminal + copy/paste.
 *
 * Flow:
 *   SERVER:
 *     1. Generate SDP offer → compress → display QR in terminal
 *     2. Wait for user to paste compressed SDP answer from client
 *     3. Set answer → WebRTC DataChannel connects
 *
 *   CLIENT:
 *     1. User pastes compressed SDP offer from server (scanned QR)
 *     2. Generate SDP answer → compress → display QR in terminal
 *     3. WebRTC DataChannel connects
 *     4. Start local HTTP proxy for OpenAI-compatible requests
 */

import * as zlib from "zlib";
import * as readline from "readline";

/**
 * Compress an SDP string into a compact base64 string for QR display.
 */
export function compressSDP(sdp: string): string {
  const compressed = zlib.deflateRawSync(Buffer.from(sdp, "utf-8"), { level: 9 });
  return compressed.toString("base64url");
}

/**
 * Decompress a base64url-encoded SDP string.
 */
export function decompressSDP(encoded: string): string {
  const buf = Buffer.from(encoded, "base64url");
  const decompressed = zlib.inflateRawSync(buf);
  return decompressed.toString("utf-8");
}

/**
 * Display a QR code in the terminal using qrcode-terminal.
 */
export async function displayQR(data: string, label: string): Promise<void> {
  try {
    const qrcode = await import("qrcode-terminal");
    const qr = (qrcode as any).default ?? qrcode;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${"═".repeat(60)}\n`);
    
    await new Promise<void>((resolve) => {
      qr.generate(data, { small: true }, (qrText: string) => {
        console.log(qrText);
        resolve();
      });
    });

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  Compressed SDP (${data.length} chars):`);
    console.log(`  ${data}`);
    console.log(`${"─".repeat(60)}\n`);
  } catch {
    // Fallback if qrcode-terminal not available
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${"═".repeat(60)}`);
    console.log(`\n  Compressed SDP (${data.length} chars):\n`);
    console.log(`  ${data}\n`);
    console.log(`${"─".repeat(60)}\n`);
  }
}

/**
 * Prompt the user to paste a compressed SDP string.
 * Reads a single line from stdin.
 */
export function promptForSDP(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${prompt}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
