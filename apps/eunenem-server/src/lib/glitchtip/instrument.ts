/**
 * GlitchTip (Sentry-compatible) error-tracking init for the
 * eunenem-server (aperture-sm4el).
 *
 * MUST be the FIRST import of the server entrypoint (server.tsx) —
 * Sentry convention: instrument before anything else loads so failures
 * during other modules' init are still captured.
 *
 * **Boot contract:** if `GLITCHTIP_DSN` is unset/empty, this module is a
 * deliberate no-op — the server boots fine in dev/test/CI without the
 * env. (`Sentry.init` with an undefined dsn would already be a no-op,
 * but we're explicit about it and log one line so the disabled state is
 * visible in the process log instead of silently ambiguous.)
 *
 * Kept minimal on purpose — GlitchTip's strength is error events:
 * no performance tracing (`tracesSampleRate: 0`), no profiling, no
 * replay, no extra integrations.
 *
 * Process-level crash capture comes from @sentry/node's DEFAULT
 * integrations (OnUncaughtException / OnUnhandledRejection) — do NOT add
 * manual `process.on(...)` handlers here, they would double-capture.
 * The only tweak: the unhandled-rejection integration defaults to mode
 * 'warn', which keeps the process ALIVE after an unhandled rejection —
 * that would silently change Node's default crash-on-unhandled-rejection
 * behavior. `mode: 'strict'` preserves it: capture + flush + exit, same
 * observable behavior as running without the SDK.
 */
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import type { RequestFailureReporter } from '../../../server/request-observability.js';

const dsn = process.env.GLITCHTIP_DSN;

// Privacy categories only. A mutable Error.stack can spoof a suffix/line, so
// these values are diagnostic labels and are never source-authentication.
const ALLOWED_FRAME_SUFFIXES = [
  'apps/eunenem-server/server.tsx',
  'apps/eunenem-server/server/request-observability.ts',
  'apps/eunenem-server/server/webhooks/stripe-webhook.ts',
  'apps/eunenem-server/src/lib/glitchtip/instrument.ts',
  'src/observability/console-logger.ts',
] as const;
const UNKNOWN_FRAME = '[application-frame]';

if (!dsn) {
  console.log('GlitchTip disabled — no DSN');
} else {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: [
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
    ],
  });
}

export function sanitizeGlitchTipRequestError(error: unknown): Error {
  const safe = new Error('HTTP request failed');
  safe.name = 'ServerRequestFailure';

  // Retain code locations without retaining the original first line, whose
  // message may contain a request value, provider body, email, or other PII.
  if (error instanceof Error && typeof error.stack === 'string') {
    const frames = error.stack
      .split('\n')
      .slice(1)
      .filter((line) => /^\s*at\s/.test(line))
      .slice(0, 30);
    if (frames.length > 0) safe.stack = `${safe.name}: ${safe.message}\n${frames.join('\n')}`;
  }
  return safe;
}

function safeFrameFilename(filename: string | undefined): string {
  if (!filename) return UNKNOWN_FRAME;
  return (
    ALLOWED_FRAME_SUFFIXES.find(
      (suffix) => filename === suffix || filename.endsWith(`/${suffix}`),
    ) ?? UNKNOWN_FRAME
  );
}

function safePositiveInteger(value: number | undefined, max: number): number | undefined {
  return Number.isInteger(value) && (value ?? 0) > 0 && (value ?? 0) <= max ? value : undefined;
}

/**
 * Report one server failure without attaching the raw Fetch Request.
 * The caller supplies a closed, value-free context envelope.
 */
export const captureGlitchTipRequestFailure: RequestFailureReporter = (error, context) => {
  if (!dsn) return;
  const sanitized = sanitizeGlitchTipRequestError(error);
  const frames = sanitized.stack
    ? Sentry.defaultStackParser(sanitized.stack)
        .slice(-30)
        .map((frame) => ({
          filename: safeFrameFilename(frame.filename),
          lineno: safePositiveInteger(frame.lineno, 1_000_000),
          colno: safePositiveInteger(frame.colno, 100_000),
          in_app: safeFrameFilename(frame.filename) !== UNKNOWN_FRAME,
        }))
    : [];
  const fixedTags = {
    request_id: context.requestId,
    request_method: context.method,
    request_route: context.route,
    failure_source: context.source,
    status_code: String(context.statusCode),
  };
  const candidateEnvironment = process.env.NODE_ENV ?? 'development';
  const safeEnvironment = /^[A-Za-z0-9_.-]{1,32}$/.test(candidateEnvironment)
    ? candidateEnvironment
    : 'unknown';
  const eventId = randomUUID().replaceAll('-', '');
  const timestamp = Date.now() / 1_000;

  Sentry.withIsolationScope((isolationScope) => {
    // Node request integrations primarily store ambient data on the isolation
    // scope. Clear that fork as well as the current-scope fork below. Clearing
    // only one of them leaves tags, contexts or attachments from the other.
    isolationScope.clear();
    Sentry.withScope((scope) => {
      // Clear every inherited carrier before adding this event's closed
      // metadata envelope: tags, contexts, extras, attachments, fingerprint,
      // transaction and span. The client remains attached for capture.
      scope.clear();
      // Scope.clear() intentionally retains registered event processors. An
      // inherited processor can therefore add data again after both clears.
      // This final processor returns a new allowlisted event and clears hint
      // attachments rather than trying to enumerate fields to delete.
      scope.addEventProcessor((_event, hint) => {
        hint.attachments = [];
        return {
          event_id: eventId,
          timestamp,
          level: 'error',
          platform: 'node',
          environment: safeEnvironment,
          tags: fixedTags,
          exception: {
            values: [
              {
                type: sanitized.name,
                value: sanitized.message,
                ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
              },
            ],
          },
        };
      });
      scope.setLevel('error');
      scope.setTags(fixedTags);
      Sentry.captureException(sanitized);
    });
  });
};
