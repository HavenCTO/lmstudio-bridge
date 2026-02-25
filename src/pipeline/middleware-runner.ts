/**
 * Middleware pipeline runner.
 *
 * Executes middleware in order for requests and in reverse order for responses
 * (onion model), calling next() to advance through the chain.
 */

import {
  Middleware,
  RequestPayload,
  ResponsePayload,
  NextFunction,
} from "../types";

export class MiddlewareRunner {
  private middlewares: Middleware[] = [];

  /** Register a middleware */
  use(mw: Middleware): void {
    this.middlewares.push(mw);
    console.log(`[pipeline] registered middleware: ${mw.name}`);
  }

  /** Run all onRequest hooks in registration order */
  async runRequest(payload: RequestPayload): Promise<void> {
    const chain = this.middlewares
      .filter((mw) => mw.onRequest)
      .map((mw) => mw.onRequest!);

    await this.executeChain(chain, payload);
  }

  /** Run all onResponse hooks in reverse registration order */
  async runResponse(payload: ResponsePayload): Promise<void> {
    const chain = this.middlewares
      .filter((mw) => mw.onResponse)
      .map((mw) => mw.onResponse!)
      .reverse();

    await this.executeChain(chain, payload);
  }

  /** Get count of registered middlewares */
  get count(): number {
    return this.middlewares.length;
  }

  private async executeChain<T>(
    handlers: Array<(payload: T, next: NextFunction) => Promise<void>>,
    payload: T
  ): Promise<void> {
    let index = 0;

    const next: NextFunction = async () => {
      if (index < handlers.length) {
        const handler = handlers[index++];
        await handler(payload, next);
      }
    };

    await next();
  }
}