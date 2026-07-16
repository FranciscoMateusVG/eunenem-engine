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
import * as Sentry from '@sentry/node';

const dsn = process.env.GLITCHTIP_DSN;

if (!dsn) {
  console.log('GlitchTip disabled — no DSN');
} else {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
    integrations: [
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
    ],
  });
}
