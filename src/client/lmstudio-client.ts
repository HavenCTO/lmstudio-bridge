/**
 * HTTP client for LM Studio's /api/v1/chat endpoint.
 * Uses native Node.js fetch (available in Node 18+).
 */

import { LMStudioChatRequest, LMStudioChatResponse } from "../types";

export interface LMStudioClientOptions {
  /** Base URL, default http://localhost:1234 */
  baseUrl: string;
  /** Optional API token */
  apiToken?: string;
  /** Request timeout in ms, default 0 (no timeout / infinite) */
  timeoutMs: number;
}

const DEFAULTS: LMStudioClientOptions = {
  baseUrl: "http://localhost:1234",
  timeoutMs: 0, // 0 = no timeout (infinite wait for LLM inference)
};

export class LMStudioClient {
  private options: LMStudioClientOptions;

  constructor(options?: Partial<LMStudioClientOptions>) {
    this.options = { ...DEFAULTS, ...options };
    console.log(`[lmstudio-client] targeting ${this.options.baseUrl}`);
  }

  /**
   * Send a chat request to LM Studio and return the response.
   */
  async chat(request: LMStudioChatRequest): Promise<LMStudioChatResponse> {
    const url = `${this.options.baseUrl}/api/v1/chat`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.options.apiToken) {
      headers["Authorization"] = `Bearer ${this.options.apiToken}`;
    }

    // Only use AbortController for explicit aborts, not for timeouts
    // timeoutMs = 0 means infinite wait (no timeout)
    const fetchOptions: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    };

    // Only apply timeout if explicitly set (> 0)
    let controller: AbortController | undefined;
    let timeout: NodeJS.Timeout | undefined;
    
    if (this.options.timeoutMs > 0) {
      controller = new AbortController();
      timeout = setTimeout(() => controller!.abort(), this.options.timeoutMs);
      fetchOptions.signal = controller.signal;
    }

    try {
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `LM Studio returned ${response.status}: ${body}`
        );
      }

      const data = (await response.json()) as LMStudioChatResponse;
      return data;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError" && this.options.timeoutMs > 0) {
        throw new Error(
          `LM Studio request timed out after ${this.options.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Health check – tries to reach LM Studio.
   * Uses a reasonable timeout (30s) since this is just a health check.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(30000), // 30s timeout for health check only
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get list of models from LM Studio.
   * Uses a reasonable timeout (30s) since this is just a metadata fetch.
   */
  async getModels(): Promise<{ object: string; data: any[] }> {
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(30000), // 30s timeout for model list fetch
      });
      if (!response.ok) {
        throw new Error(`LM Studio returned ${response.status}`);
      }
      return await response.json() as { object: string; data: any[] };
    } catch (err: unknown) {
      console.error(`[lmstudio-client] failed to get models:`, err);
      return { object: "list", data: [] };
    }
  }
}