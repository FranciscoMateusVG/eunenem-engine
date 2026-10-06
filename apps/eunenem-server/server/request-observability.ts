import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { Logger } from '../../../src/observability/logger.js';
import { runWithLogContext } from '../../../src/observability/log-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_METHOD = /^[A-Z]{1,16}$/;
const SAFE_ROUTE = /^[A-Za-z0-9_./:*-]{1,160}$/;

export type RequestFailureSource = 'hono' | 'response' | 'trpc';

export interface RequestFailureContext {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly source: RequestFailureSource;
}

export type RequestFailureReporter = (
  error: unknown,
  context: RequestFailureContext,
) => void;

interface RequestState {
  readonly requestId: string;
  readonly logger: Logger;
  readonly reporter: RequestFailureReporter;
  reported: boolean;
}

const requestStates = new WeakMap<Context, RequestState>();

function safeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return SAFE_METHOD.test(normalized) ? normalized : 'OTHER';
}

function safeRoute(route: string | undefined): string {
  return route && SAFE_ROUTE.test(route) ? route : 'unmatched';
}

function safeStatus(statusCode: number): number {
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
}

export function reportRequestFailure(
  context: Context,
  error: unknown,
  input: {
    readonly source: RequestFailureSource;
    readonly statusCode?: number;
    readonly route?: string;
  },
): void {
  const state = requestStates.get(context);
  if (!state || state.reported) return;

  state.reported = true;
  const failureContext: RequestFailureContext = {
    requestId: state.requestId,
    method: safeMethod(context.req.method),
    route: safeRoute(input.route ?? context.req.routePath),
    statusCode: safeStatus(input.statusCode ?? context.res.status),
    source: input.source,
  };

  // Observability must not turn a handled failure into a second application
  // failure. The logger receives only the fixed envelope above. The production
  // reporter sanitizes the exception before capture and removes ambient HTTP
  // request data from the event.
  try {
    state.logger.error('http.request.failed', { ...failureContext });
  } catch {
    // The request outcome remains authoritative if the log sink is broken.
  }
  try {
    state.reporter(error, failureContext);
  } catch {
    // Error reporting is best-effort and must never alter HTTP semantics.
  }
}

export interface RequestObservabilityOptions {
  readonly logger: Logger;
  readonly reportFailure: RequestFailureReporter;
  /** Deterministic test seam. Production uses crypto.randomUUID(). */
  readonly generateRequestId?: () => string;
}

/**
 * Body-neutral request correlation and internal-failure capture.
 *
 * Incoming X-Request-Id is intentionally ignored. Accepting it would let a
 * caller choose a trusted correlation key and forge relationships in logs.
 */
export function createRequestObservabilityMiddleware(
  options: RequestObservabilityOptions,
): MiddlewareHandler {
  return async (context, next) => {
    const generated = options.generateRequestId?.() ?? randomUUID();
    const requestId = UUID.test(generated) ? generated : randomUUID();
    requestStates.set(context, {
      requestId,
      logger: options.logger,
      reporter: options.reportFailure,
      reported: false,
    });
    context.header(REQUEST_ID_HEADER, requestId);

    await runWithLogContext({ requestId }, async () => {
      try {
        await next();
      } catch (error) {
        reportRequestFailure(context, error, { source: 'hono', statusCode: 500 });
        throw error;
      }

      if (context.res.status >= 500) {
        const honoError = context.error;
        reportRequestFailure(context, honoError ?? new Error('HTTP response failed'), {
          source: honoError === undefined ? 'response' : 'hono',
        });
      }
    });
  };
}

/**
 * Capture a handled tRPC internal failure which may be encoded in a 2xx batch
 * response and therefore cannot be found from the outer HTTP status alone.
 */
export function reportTrpcInternalFailure(
  context: Context,
  input: { readonly error: unknown; readonly path?: string },
): void {
  const path = input.path && /^[A-Za-z0-9._-]{1,120}$/.test(input.path)
    ? `trpc.${input.path}`
    : 'trpc.unknown';
  reportRequestFailure(context, input.error, {
    source: 'trpc',
    route: path,
    statusCode: 500,
  });
}
