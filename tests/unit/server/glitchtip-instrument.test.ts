import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeGlitchTipRequestError } from '../../../apps/eunenem-server/src/lib/glitchtip/instrument.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GlitchTip request error sanitization', () => {
  it('retains stack locations without the arbitrary error message', () => {
    const source = new Error('customer@example.com provider-secret-body');
    const sanitized = sanitizeGlitchTipRequestError(source);

    expect(sanitized.name).toBe('ServerRequestFailure');
    expect(sanitized.message).toBe('HTTP request failed');
    expect(sanitized.stack).toContain('glitchtip-instrument.test.ts');
    expect(sanitized.stack).not.toContain('customer@example.com');
    expect(sanitized.stack).not.toContain('provider-secret-body');
  });

  it('maps non-Error throws to one fixed value', () => {
    const sanitized = sanitizeGlitchTipRequestError({ raw: 'private payload' });

    expect(sanitized.name).toBe('ServerRequestFailure');
    expect(sanitized.message).toBe('HTTP request failed');
    expect(sanitized.stack).not.toContain('private payload');
  });

  it('emits no ambient scope carriers and leaves the outer scope unchanged', async () => {
    vi.resetModules();
    vi.stubEnv('GLITCHTIP_DSN', 'https://public@example.invalid/1');

    const instrument = await import('../../../apps/eunenem-server/src/lib/glitchtip/instrument.js');
    const Sentry = await import(
      '../../../apps/eunenem-server/node_modules/@sentry/node/build/esm/index.js'
    );
    await Sentry.close(0);

    const capturedEnvelopes: unknown[] = [];
    Sentry.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      transport: () => ({
        send: async (envelope) => {
          capturedEnvelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });

    const canary = 'customer@example.com/private-token';
    const seedHostileScope = (scope: InstanceType<typeof Sentry.Scope>, prefix: string) => {
      scope.setUser({ id: `${prefix}:${canary}` });
      scope.addBreadcrumb({ message: `${prefix}:${canary}` });
      scope.setTag(`${prefix}_private_tag`, canary);
      scope.setContext(`${prefix}_private_context`, { value: canary });
      scope.setExtra(`${prefix}_private_extra`, canary);
      scope.setAttribute(`${prefix}_private_attribute`, canary);
      scope.addAttachment({ filename: `${prefix}-private.txt`, data: canary });
      scope.setFingerprint([`${prefix}:${canary}`]);
      scope.setTransactionName(`${prefix}:${canary}`);
      scope.setConversationId(`${prefix}:${canary}`);
      scope.addEventProcessor((event, hint) => {
        hint.attachments = [{ filename: `${prefix}-processor.txt`, data: canary }];
        return {
          ...event,
          request: { url: `https://example.invalid/${prefix}/${canary}` },
          tags: { ...event.tags, [`${prefix}_processor_tag`]: canary },
          contexts: {
            ...event.contexts,
            [`${prefix}_processor_context`]: { value: canary },
          },
          fingerprint: [`${prefix}:processor:${canary}`],
          transaction: `${prefix}:processor:${canary}`,
        };
      });
    };
    const expectUnchanged = (
      before: ReturnType<InstanceType<typeof Sentry.Scope>['getScopeData']>,
      after: ReturnType<InstanceType<typeof Sentry.Scope>['getScopeData']>,
    ) => {
      expect(after.user).toEqual(before.user);
      expect(after.breadcrumbs).toEqual(before.breadcrumbs);
      expect(after.tags).toEqual(before.tags);
      expect(after.contexts).toEqual(before.contexts);
      expect(after.extra).toEqual(before.extra);
      expect(after.attributes).toEqual(before.attributes);
      expect(after.attachments).toEqual(before.attachments);
      expect(after.fingerprint).toEqual(before.fingerprint);
      expect(after.transactionName).toBe(before.transactionName);
      expect(after.conversationId).toBe(before.conversationId);
      expect(after.eventProcessors).toEqual(before.eventProcessors);
    };

    await Sentry.withIsolationScope(async (outerIsolationScope) => {
      // Top-level setters and Node request integrations target the isolation
      // scope; seed through those real entry points, not only through a Scope
      // instance handed to the test.
      Sentry.setUser({ id: `isolation:${canary}` });
      Sentry.addBreadcrumb({ message: `isolation:${canary}` });
      Sentry.setTag('isolation_private_tag', canary);
      Sentry.setContext('isolation_private_context', { value: canary });
      Sentry.setExtra('isolation_private_extra', canary);
      const activeIsolationScope = Sentry.getIsolationScope();
      activeIsolationScope.setAttribute('isolation_private_attribute', canary);
      activeIsolationScope.addAttachment({ filename: 'isolation-private.txt', data: canary });
      activeIsolationScope.setFingerprint([`isolation:${canary}`]);
      activeIsolationScope.setTransactionName(`isolation:${canary}`);
      activeIsolationScope.setConversationId(`isolation:${canary}`);
      activeIsolationScope.addEventProcessor((event, hint) => {
        hint.attachments = [{ filename: 'isolation-processor.txt', data: canary }];
        return {
          ...event,
          tags: { ...event.tags, isolation_processor_tag: canary },
          contexts: {
            ...event.contexts,
            isolation_processor_context: { value: canary },
          },
          fingerprint: [`isolation:processor:${canary}`],
          transaction: `isolation:processor:${canary}`,
        };
      });
      const isolationBefore = outerIsolationScope.getScopeData();

      await Sentry.withScope(async (outerScope) => {
        seedHostileScope(outerScope, 'current');
        const currentBefore = outerScope.getScopeData();

        await Sentry.startSpan({ name: canary, op: 'ambient.private' }, async () => {
          const hostileError = new Error(canary);
          hostileError.stack = [
            `Error: ${canary}`,
            `    at customerFunction_${canary} (/srv/${canary}.ts:12:3)`,
            `    at customerFunction_${canary} (/app/apps/eunenem-server/server/webhooks/stripe-webhook.ts:299:10)`,
          ].join('\n');
          instrument.captureGlitchTipRequestFailure(hostileError, {
            requestId: '00000000-0000-4000-8000-000000000001',
            method: 'POST',
            route: '/api/webhooks/stripe',
            statusCode: 500,
            source: 'hono',
          });
          await Sentry.flush(2_000);
        });
        expectUnchanged(currentBefore, outerScope.getScopeData());
      });
      expectUnchanged(isolationBefore, outerIsolationScope.getScopeData());
    });

    expect(capturedEnvelopes.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(capturedEnvelopes);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('ambient_private');
    expect(serialized).toContain('ServerRequestFailure');
    expect(serialized).toContain('00000000-0000-4000-8000-000000000001');

    const eventEnvelope = capturedEnvelopes.find((envelope) =>
      (envelope as [unknown, Array<[{ type?: string }, unknown]>])[1].some(
        ([header]) => header.type === 'event',
      ),
    ) as [unknown, Array<[{ type?: string }, Record<string, unknown>]>] | undefined;
    const event = eventEnvelope?.[1].find(([header]) => header.type === 'event')?.[1];
    expect(event).toBeDefined();
    const allowedEventKeys = new Set([
      'environment',
      'event_id',
      'exception',
      'level',
      'platform',
      'sdk',
      'tags',
      'timestamp',
      // Sentry adds a fresh propagation-only trace context after scope event
      // processors. Both scopes were cleared, so this is a new random pair,
      // not the ambient active span seeded above.
      'contexts',
    ]);
    expect(Object.keys(event ?? {}).filter((key) => !allowedEventKeys.has(key))).toEqual([]);
    const contexts = event?.contexts as
      | { trace?: { trace_id?: string; span_id?: string; [key: string]: unknown } }
      | undefined;
    expect(Object.keys(contexts ?? {})).toEqual(['trace']);
    expect(Object.keys(contexts?.trace ?? {}).sort()).toEqual(['span_id', 'trace_id']);
    expect(contexts?.trace?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(contexts?.trace?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(event?.tags).toEqual({
      request_id: '00000000-0000-4000-8000-000000000001',
      request_method: 'POST',
      request_route: '/api/webhooks/stripe',
      failure_source: 'hono',
      status_code: '500',
    });
    const exception = event?.exception as
      | { values?: Array<{ stacktrace?: { frames?: Array<Record<string, unknown>> } }> }
      | undefined;
    const frames = exception?.values?.[0]?.stacktrace?.frames ?? [];
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: '[application-frame]', lineno: 12, colno: 3 }),
        expect.objectContaining({
          filename: 'apps/eunenem-server/server/webhooks/stripe-webhook.ts',
          lineno: 299,
          colno: 10,
          in_app: true,
        }),
      ]),
    );
    for (const frame of frames) {
      expect(Object.keys(frame).sort()).toEqual(['colno', 'filename', 'in_app', 'lineno']);
    }
    const attachmentItems = capturedEnvelopes.flatMap((envelope) =>
      (envelope as [unknown, Array<[{ type?: string }, unknown]>])[1].filter(
        ([header]) => header.type === 'attachment',
      ),
    );
    expect(attachmentItems).toEqual([]);

    await Sentry.close(0);
  });
});
