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
  /** Request timeout in ms, default 120000 */
  timeoutMs: number;
}

const DEFAULTS: LMStudioClientOptions = {
  baseUrl: "http://localhost:1234",
  timeoutMs: 120_000,
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

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `LM Studio returned ${response.status}: ${body}`
        );
      }

      const data = (await response.json()) as LMStudioChatResponse;
      return data;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `LM Studio request timed out after ${this.options.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check – tries to reach LM Studio.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get list of models from LM Studio.
   */
  async getModels(): Promise<{ object: string; data: any[] }> {
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
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