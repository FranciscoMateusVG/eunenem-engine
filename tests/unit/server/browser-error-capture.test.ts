import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  computeBrowserArtifactRelease,
  writeBrowserArtifactRelease,
} from '../../../apps/eunenem-server/browser-artifact-release.mjs';
import { bootstrapClient } from '../../../apps/eunenem-server/client-bootstrap.js';
import * as Sentry from '../../../apps/eunenem-server/node_modules/@sentry/react/build/esm/index.js';
import {
  type BrowserErrorRuntimeConfig,
  browserErrorRuntimeConfigFromEnv,
  validateBrowserErrorConfig,
} from '../../../apps/eunenem-server/pages/lib/browser-error-contract.js';
import {
  initializeBrowserErrorCapture,
  safeBrowserFrames,
} from '../../../apps/eunenem-server/pages/lib/browser-errors.js';
import {
  browserArtifactAssetUrl,
  clientRuntimeEnvScript,
  readBrowserArtifactRelease,
} from '../../../apps/eunenem-server/server/client-runtime-env.js';

const DSN = 'https://0123456789abcdef@example.invalid/1';
const RELEASE = `artifact-sha256:${'a'.repeat(64)}`;

class FakeBrowserTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

function config(input: Partial<BrowserErrorRuntimeConfig> = {}): BrowserErrorRuntimeConfig {
  return { browserErrorDsn: DSN, release: RELEASE, ...input };
}

function eventFromEnvelope(envelope: unknown): Record<string, unknown> | undefined {
  return (envelope as [unknown, Array<[{ type?: string }, Record<string, unknown>]>])[1].find(
    ([header]) => header.type === 'event',
  )?.[1];
}

function seedScope(scope: InstanceType<typeof Sentry.Scope>, prefix: string, canary: string): void {
  scope.setUser({ id: `${prefix}:${canary}` });
  scope.addBreadcrumb({ message: `${prefix}:${canary}` });
  scope.setTag(`${prefix}_tag`, canary);
  scope.setContext(`${prefix}_context`, { value: canary });
  scope.setExtra(`${prefix}_extra`, canary);
  scope.setFingerprint([`${prefix}:${canary}`]);
  scope.setTransactionName(`${prefix}:${canary}`);
  scope.addAttachment({ filename: `${prefix}.txt`, data: canary });
  scope.addEventProcessor((event, hint) => {
    hint.attachments = [{ filename: `${prefix}-processor.txt`, data: canary }];
    return {
      ...event,
      timestamp: 0,
      release: canary,
      environment: canary,
      platform: canary,
      level: 'fatal',
      user: { id: canary },
      request: { url: `https://example.invalid/${canary}?secret=${canary}` },
      tags: { ...event.tags, [`${prefix}_processor_tag`]: canary },
      contexts: { ...event.contexts, [`${prefix}_processor_context`]: { value: canary } },
      extra: { value: canary },
      breadcrumbs: [{ message: canary }],
      fingerprint: [canary],
      transaction: canary,
    };
  });
  scope.addEventProcessor((event) => {
    event.release = canary;
    event.environment = canary;
    event.user = { id: canary };
    event.request = { url: `https://example.invalid/${canary}` };
    event.tags = { inplace_processor_tag: canary };
    const exception = event.exception?.values?.[0];
    if (exception) {
      exception.type = canary;
      exception.value = canary;
    }
    const frame = exception?.stacktrace?.frames?.[0];
    if (frame) {
      frame.filename = canary;
      frame.function = canary;
      frame.lineno = 999_999;
    }
    return event;
  });
}

describe('browser error public config', () => {
  it('requires a dedicated HTTPS public DSN and exact release', () => {
    expect(validateBrowserErrorConfig(config())).toEqual({ dsn: DSN, release: RELEASE });
    expect(validateBrowserErrorConfig(undefined)).toBeNull();
    expect(validateBrowserErrorConfig(config({ browserErrorDsn: undefined }))).toBeNull();
    expect(validateBrowserErrorConfig(config({ release: undefined }))).toBeNull();
    expect(
      validateBrowserErrorConfig(
        config({ browserErrorDsn: 'https://0123456789abcdef:secret@example.invalid/1' }),
      ),
    ).toBeNull();
    expect(
      validateBrowserErrorConfig(
        config({ browserErrorDsn: `${DSN}?customer=customer@example.com` }),
      ),
    ).toBeNull();
    expect(validateBrowserErrorConfig(config({ release: 'not-a-commit' }))).toBeNull();
    expect(
      browserErrorRuntimeConfigFromEnv({
        browserDsn: DSN,
        serverDsn: DSN,
        release: RELEASE,
      }),
    ).toEqual({});
    expect(
      browserErrorRuntimeConfigFromEnv({
        browserDsn: DSN,
        serverDsn: 'https://0123456789abcdef@EXAMPLE.INVALID:443/1',
        release: RELEASE,
      }),
    ).toEqual({});
    expect(browserErrorRuntimeConfigFromEnv({ browserDsn: DSN, release: RELEASE })).toEqual({
      browserErrorDsn: DSN,
      release: RELEASE,
    });
  });

  it('stays disabled without valid config and never installs listeners', () => {
    const target = new FakeBrowserTarget();
    const capture = initializeBrowserErrorCapture(
      { browserErrorDsn: 'server-secret-or-malformed', release: RELEASE },
      { target: target as unknown as Window },
    );

    expect(capture.enabled).toBe(false);
    expect(target.listeners.size).toBe(0);
    expect(() => capture.capture('bootstrap', new Error('customer@example.com'))).not.toThrow();
  });

  it('does not break rendering when SDK initialization fails', () => {
    const target = new FakeBrowserTarget();
    const capture = initializeBrowserErrorCapture(config(), {
      target: target as unknown as Window,
      origin: 'https://eunenem.com',
      transport: () => {
        throw new Error('transport init failure');
      },
    });

    expect(capture.enabled).toBe(false);
    expect(target.listeners.size).toBe(0);
  });

  it('stays disabled outside the exact production origins', () => {
    const target = new FakeBrowserTarget();
    const capture = initializeBrowserErrorCapture(config(), {
      target: target as unknown as Window,
      origin: 'https://customer.example.com',
    });
    expect(capture.enabled).toBe(false);
    expect(target.listeners.size).toBe(0);
  });

  it.each([
    'error',
    'unhandledrejection',
  ] as const)('continues hydration and rolls back when %s listener registration fails', async (throwingType) => {
    await Sentry.close(0);
    class ThrowingTarget extends FakeBrowserTarget {
      readonly __EUNENEM_ENV__ = config();
      readonly location = { origin: 'https://eunenem.com', pathname: '/faq' };

      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
      ): void {
        if (type === throwingType) throw new Error('listener registration unavailable');
        super.addEventListener(type, listener);
      }

      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
      ): void {
        super.removeEventListener(type, listener);
        if (throwingType === 'unhandledrejection' && type === 'error') {
          throw new Error('listener cleanup unavailable');
        }
      }
    }
    const target = new ThrowingTarget();
    const hydrate = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));

    await bootstrapClient({
      document: { getElementById: () => ({}) as HTMLElement },
      targetWindow: target as unknown as Window,
      hydrate: hydrate as unknown as Parameters<typeof bootstrapClient>[0]['hydrate'],
      loadApp: async () => ({ App: () => null, resolveRoute: () => ({ kind: 'faq' }) }),
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(target.listeners.get('error')?.size ?? 0).toBe(0);
    expect(target.listeners.get('unhandledrejection')?.size ?? 0).toBe(0);
  });

  it('keeps hydration working when browser capture is not configured', async () => {
    const target = new FakeBrowserTarget() as FakeBrowserTarget & {
      __EUNENEM_ENV__?: BrowserErrorRuntimeConfig;
      location: { pathname: string };
    };
    target.location = { pathname: '/faq' };
    const hydrate = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));

    await bootstrapClient({
      document: { getElementById: () => ({}) as HTMLElement },
      targetWindow: target as unknown as Window,
      hydrate: hydrate as unknown as Parameters<typeof bootstrapClient>[0]['hydrate'],
      loadApp: async () => ({ App: () => null, resolveRoute: () => ({ kind: 'faq' }) }),
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(target.listeners.size).toBe(0);
  });

  it('wires the React 19 root callbacks to the centralized capture', async () => {
    const onCaughtError = vi.fn();
    const onRecoverableError = vi.fn();
    const onUncaughtError = vi.fn();
    const setRouteKind = vi.fn();
    const capture = vi.fn();
    const hydrate = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));
    const target = {
      __EUNENEM_ENV__: config(),
      location: { pathname: '/admin/pagamento/opaque-id' },
    } as unknown as Window;

    await bootstrapClient({
      document: { getElementById: () => ({}) as HTMLElement },
      targetWindow: target,
      hydrate: hydrate as unknown as Parameters<typeof bootstrapClient>[0]['hydrate'],
      loadApp: async () => ({
        App: () => null,
        resolveRoute: () => ({ kind: 'admin-pagamento' }),
      }),
      createErrorCapture: () => ({
        enabled: true,
        onCaughtError,
        onRecoverableError,
        onUncaughtError,
        capture,
        setRouteKind,
        dispose: vi.fn(),
      }),
    });

    expect(setRouteKind).toHaveBeenCalledWith('admin-pagamento');
    const rootOptions = hydrate.mock.calls[0]?.[2];
    expect(rootOptions).toMatchObject({ onCaughtError, onRecoverableError, onUncaughtError });
    rootOptions?.onUncaughtError?.(new Error('not sent by this mock'), {
      componentStack: 'not sent',
    });
    expect(onUncaughtError).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('browser error stack boundary', () => {
  it('keeps only fixed frame categories and bounded numeric locations', () => {
    const canary = 'customer@example.com/private-token';
    const error = new Error(canary);
    error.stack = [
      `Error: ${canary}`,
      `    at customer_${canary} (https://eunenem.com/public/client.js:1:4500)`,
      `    at customer_${canary} (/srv/${canary}.tsx:12:3)`,
      `    at customer_${canary} (/srv/too-large.ts:1000001:100001)`,
    ].join('\n');

    const frames = safeBrowserFrames(error);
    expect(frames).toEqual([
      { filename: '[application-frame]', lineno: 12, colno: 3, in_app: false },
      { filename: '[client-bundle]', lineno: 1, colno: 4500, in_app: true },
    ]);
    expect(JSON.stringify(frames)).not.toContain(canary);
  });
});

describe('browser artifact release and Hono runtime envelope', () => {
  it('versions browser assets with the build release so clients cannot reuse stale UI', () => {
    expect(browserArtifactAssetUrl('/public/client.js', RELEASE)).toBe(
      `/public/client.js?v=${encodeURIComponent(RELEASE)}`,
    );
    expect(browserArtifactAssetUrl('/public/styles.css', RELEASE)).toBe(
      `/public/styles.css?v=${encodeURIComponent(RELEASE)}`,
    );
    expect(browserArtifactAssetUrl('/public/client.js', undefined)).toBe('/public/client.js');
  });

  it('hashes both fixed assets deterministically and changes on either input', () => {
    const first = computeBrowserArtifactRelease({
      client: Buffer.from('client-a'),
      styles: Buffer.from('styles-a'),
    });
    expect(first).toMatch(/^artifact-sha256:[0-9a-f]{64}$/);
    expect(
      computeBrowserArtifactRelease({
        client: Buffer.from('client-a'),
        styles: Buffer.from('styles-a'),
      }),
    ).toBe(first);
    expect(
      computeBrowserArtifactRelease({
        client: Buffer.from('client-b'),
        styles: Buffer.from('styles-a'),
      }),
    ).not.toBe(first);
    expect(
      computeBrowserArtifactRelease({
        client: Buffer.from('client-a'),
        styles: Buffer.from('styles-b'),
      }),
    ).not.toBe(first);
  });

  it('writes and reads fixed app-root metadata while missing or malformed metadata fails closed', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'eunenem-browser-release-dev-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'eunenem-browser-release-prod-'));
    try {
      for (const root of [firstRoot, secondRoot]) {
        mkdirSync(join(root, 'public'));
        writeFileSync(join(root, 'public/client.js'), 'same-client');
        writeFileSync(join(root, 'public/styles.css'), 'same-styles');
      }
      const first = await writeBrowserArtifactRelease(firstRoot);
      const second = await writeBrowserArtifactRelease(secondRoot);
      expect(second).toBe(first);
      expect(
        readBrowserArtifactRelease(
          pathToFileURL(join(firstRoot, 'public/browser-error-release.json')),
        ),
      ).toBe(first);

      const missing = pathToFileURL(join(firstRoot, 'public/missing-release.json'));
      expect(readBrowserArtifactRelease(missing)).toBeUndefined();
      writeFileSync(join(firstRoot, 'public/browser-error-release.json'), '{"release":"stale"}\n');
      expect(
        readBrowserArtifactRelease(
          pathToFileURL(join(firstRoot, 'public/browser-error-release.json')),
        ),
      ).toBeUndefined();
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('projects only the dedicated DSN and computed release through the actual Hono response', async () => {
    const buildApp = (
      env: Readonly<Record<string, string | undefined>>,
      release: string | undefined,
    ) => {
      const app = new Hono();
      app.get('/', (context) =>
        context.html(`<!doctype html>${clientRuntimeEnvScript(env, release)}`),
      );
      return app;
    };
    const parseRuntimeEnv = async (app: Hono): Promise<Record<string, unknown>> => {
      const response = await app.request('https://eunenem.com/');
      expect(response.status).toBe(200);
      const html = await response.text();
      const serialized = html.match(/window\.__EUNENEM_ENV__=(\{[^<]*\})/)?.[1];
      expect(serialized).toBeDefined();
      return JSON.parse(serialized ?? '{}');
    };

    expect(
      await parseRuntimeEnv(
        buildApp(
          {
            GLITCHTIP_BROWSER_DSN: DSN,
            GLITCHTIP_DSN: 'https://fedcba9876543210@server.invalid/1',
          },
          RELEASE,
        ),
      ),
    ).toEqual({ browserErrorDsn: DSN, release: RELEASE });
    expect(await parseRuntimeEnv(buildApp({ GLITCHTIP_BROWSER_DSN: DSN }, undefined))).toEqual({});
    expect(
      await parseRuntimeEnv(buildApp({ GLITCHTIP_BROWSER_DSN: DSN, GLITCHTIP_DSN: DSN }, RELEASE)),
    ).toEqual({});
    expect(
      await parseRuntimeEnv(
        buildApp({ GLITCHTIP_BROWSER_DSN: `${DSN}?customer=private` }, RELEASE),
      ),
    ).toEqual({});
  });
});

describe('browser error SDK boundary', () => {
  afterAll(async () => {
    await Sentry.close(0);
  });

  it('captures global and React failures once through an exact closed envelope', async () => {
    await Sentry.close(0);
    const target = new FakeBrowserTarget();
    const envelopes: unknown[] = [];
    let eventSequence = 0;
    const canary = 'customer@example.com/private-token';
    let now = 1_700_000_000_000;

    const capture = initializeBrowserErrorCapture(config(), {
      target: target as unknown as Window,
      origin: 'https://eunenem.com',
      now: () => now,
      generateEventId: () => (++eventSequence).toString(16).padStart(32, '0'),
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    expect(capture.enabled).toBe(true);
    capture.setRouteKind('admin-pagamento');

    const globalScope = Sentry.getGlobalScope();
    seedScope(globalScope, 'global', canary);
    const globalBefore = globalScope.getScopeData();

    await Sentry.withIsolationScope(async (isolationScope) => {
      seedScope(isolationScope, 'isolation', canary);
      const isolationBefore = isolationScope.getScopeData();

      await Sentry.withScope(async (currentScope) => {
        seedScope(currentScope, 'current', canary);
        const currentBefore = currentScope.getScopeData();

        await Sentry.startSpan({ name: canary, op: canary }, async () => {
          const sharedError = new Error(canary);
          sharedError.stack = [
            `Error: ${canary}`,
            `    at customer_${canary} (https://eunenem.com/public/client.js:1:1234)`,
          ].join('\n');
          target.emit('error', { error: sharedError } as Event);
          // The same Error reaching React must not produce a second event.
          capture.onCaughtError(sharedError, { componentStack: canary });

          const rejection = new Error(canary);
          rejection.stack = `Error: ${canary}\n    at reject_${canary} (/srv/${canary}.js:12:3)`;
          target.emit('unhandledrejection', { reason: rejection } as Event);

          now += 6_000;
          capture.onRecoverableError(new Error(canary), { componentStack: canary });
          now += 6_000;
          capture.onUncaughtError(new Error(canary), { componentStack: canary });
          await Sentry.flush(2_000);
        });

        expect(currentScope.getScopeData()).toEqual(currentBefore);
      });
      expect(isolationScope.getScopeData()).toEqual(isolationBefore);
    });
    expect(globalScope.getScopeData()).toEqual(globalBefore);

    expect(envelopes).toHaveLength(4);
    const serialized = JSON.stringify(envelopes);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('example.invalid');
    expect(serialized).not.toContain('admin/pagamento');

    const events = envelopes.map(eventFromEnvelope);
    expect(events.every(Boolean)).toBe(true);
    expect(
      events.map(
        (event) =>
          ((event?.exception as { values?: Array<{ type?: string }> })?.values ?? [])[0]?.type,
      ),
    ).toEqual([
      'BrowserUnhandledError',
      'BrowserUnhandledRejection',
      'ReactRecoverableError',
      'ReactUncaughtError',
    ]);

    for (const event of events) {
      expect(event?.release).toBe(RELEASE);
      expect(event?.environment).toBe('production');
      expect(event?.level).toBe('error');
      expect(event?.platform).toBe('javascript');
      expect(event?.tags).toEqual({
        error_source: expect.any(String),
        route_kind: 'admin-pagamento',
      });
      const allowedKeys = new Set([
        'environment',
        'event_id',
        'exception',
        'level',
        'platform',
        'release',
        'sdk',
        'tags',
        'timestamp',
        'type',
      ]);
      expect(Object.keys(event ?? {}).filter((key) => !allowedKeys.has(key))).toEqual([]);
      expect(event?.type).toBeUndefined();
    }

    const attachmentItems = envelopes.flatMap((envelope) =>
      (envelope as [unknown, Array<[{ type?: string }, unknown]>])[1].filter(
        ([header]) => header.type === 'attachment',
      ),
    );
    expect(attachmentItems).toEqual([]);
    capture.dispose();
    expect(target.listeners.get('error')?.size ?? 0).toBe(0);
    expect(target.listeners.get('unhandledrejection')?.size ?? 0).toBe(0);
  });
});
