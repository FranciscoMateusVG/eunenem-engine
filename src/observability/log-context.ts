import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  /** Server-generated correlation ID. Never sourced from a request header. */
  readonly requestId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Run one async operation with immutable structured log context.
 *
 * The context is deliberately tiny. It is not a bag for request headers,
 * cookies, URLs, payloads, or other data that should not be copied into logs.
 */
export function runWithLogContext<T>(context: LogContext, operation: () => T): T {
  return storage.run(Object.freeze({ ...context }), operation);
}

/** Return the current immutable context, or an empty object outside a request. */
export function currentLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? {};
}
