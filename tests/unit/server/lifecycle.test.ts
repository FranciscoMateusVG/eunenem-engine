import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServerLifecycle,
  DRAIN_DEADLINE_MS,
  LifecycleAdmissionClosedError,
} from '../../../apps/eunenem-server/server/lifecycle.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup(deadlineMs = 100) {
  const job = deferred();
  const http = deferred();
  const exit = vi.fn();
  const log = vi.fn();
  const boss = {
    offWork: vi.fn(async () => {}),
    stop: vi.fn((_options: { graceful: true; timeout: number }) => job.promise),
  };
  const lifecycle = createServerLifecycle({ boss, queues: ['jobs'], log, exit, deadlineMs });
  const server = Object.assign(new EventEmitter(), {
    listening: true,
    close: vi.fn((callback: (error?: Error) => void) => {
      void http.promise.then(() => callback());
    }),
  });
  lifecycle.attachServer(server as never);
  return { lifecycle, job, http, boss, server, exit, log };
}

afterEach(() => vi.useRealTimers());

describe('server lifecycle', () => {
  it('starts unready; rejects ALL routes before listen/ready and after drain', async () => {
    const { lifecycle, http, job } = setup();
    const app = new Hono();
    app.use('*', lifecycle.admissionMiddleware);
    app.all('*', (c) => c.text('business'));
    expect(lifecycle.ready).toBe(false);
    expect((await app.request('/healthz')).status).toBe(503);
    expect(lifecycle.markReady()).toBe(true);
    expect((await app.request('/api/webhooks/stripe')).status).toBe(200);
    const stop = lifecycle.shutdown();
    expect(lifecycle.state).toBe('draining');
    expect(lifecycle.markReady()).toBe(false);
    expect(() => lifecycle.assertAdmissionOpen()).toThrow(LifecycleAdmissionClosedError);
    for (const path of ['/healthz', '/', '/api/webhooks/stripe', '/api/trpc/refund', '/public/x']) {
      const response = await app.request(path, { method: 'POST' });
      expect(response.status).toBe(503);
      expect(response.headers.get('connection')).toBe('close');
    }
    http.release();
    job.release();
    expect(await stop).toBe(0);
  });

  it('shares duplicate SIGTERM/SIGINT drain and waits for BOTH admitted HTTP and job', async () => {
    const { lifecycle, http, job, boss, server, exit, log } = setup();
    const signals = new EventEmitter();
    const remove = lifecycle.installSignalHandlers(signals as never);
    lifecycle.markReady();
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    const stop = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(stop);
    expect(boss.offWork).toHaveBeenCalledExactlyOnceWith('jobs', { wait: false });
    expect(server.close).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(boss.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true, timeout: 1100 }),
    );
    http.release();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    job.release();
    expect(await stop).toBe(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log.mock.calls.flat()).toEqual(['draining', 'drain_complete']);
    expect(lifecycle.shutdown()).toBe(stop);
    remove();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('deadline is nonzero even when native boss later resolves forced cleanup', async () => {
    vi.useFakeTimers();
    const { lifecycle, http, job, boss, exit, log } = setup();
    const stop = lifecycle.shutdown();
    http.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(await stop).toBe(1);
    expect(boss.stop.mock.calls[0]?.[0]?.timeout).toBeGreaterThan(100);
    // pg-boss graceful timeout RESOLVES after failWip; it is not success proof.
    job.release();
    await vi.advanceTimersByTimeAsync(1100);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.mock.calls.flat()).toEqual(['draining', 'drain_timeout']);
    expect(lifecycle.state).toBe('failed');
  });

  it.each([
    'callback',
    'throw',
    'boss',
  ] as const)('fixed nonsecret failure on %s; never success', async (kind) => {
    const { lifecycle, http, job, server, boss, exit, log } = setup();
    if (kind === 'callback')
      server.close.mockImplementationOnce((callback) => callback(new Error('private')));
    if (kind === 'throw')
      server.close.mockImplementationOnce(() => {
        throw new Error('private');
      });
    if (kind === 'boss') boss.stop.mockRejectedValueOnce(new Error('private'));
    const stop = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(stop);
    expect(await stop).toBe(1);
    http.release();
    job.release();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.mock.calls.flat()).toEqual([
      'draining',
      kind === 'boss' ? 'boss_stop_failed' : 'http_close_failed',
    ]);
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('signal during startup fences later registration/readiness and stops any late worker', async () => {
    const { lifecycle, http, job, boss, exit } = setup();
    const registration = deferred();
    const starting = lifecycle.startupStep(() => registration.promise);
    const rejected = expect(starting).rejects.toThrow(LifecycleAdmissionClosedError);
    expect(lifecycle.markReady()).toBe(false);
    const stop = lifecycle.shutdown();
    await Promise.resolve();
    expect(boss.stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    registration.release();
    await rejected;
    await expect(lifecycle.startupStep(async () => {})).rejects.toThrow(
      LifecycleAdmissionClosedError,
    );
    await vi.waitFor(() => expect(boss.stop).toHaveBeenCalledOnce());
    expect(boss.offWork).toHaveBeenCalledTimes(2);
    expect(lifecycle.markReady()).toBe(false);
    http.release();
    job.release();
    expect(await stop).toBe(0);
  });

  it('awaits the admitted callback even if boss silently finishes bookkeeping first', async () => {
    vi.useFakeTimers();
    const { lifecycle, http, job, exit, log } = setup();
    const callback = deferred();
    const admitted = lifecycle.runJob(() => callback.promise);
    const stop = lifecycle.shutdown();
    http.release();
    job.release();
    await vi.advanceTimersByTimeAsync(99);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await stop).toBe(1);
    callback.release();
    await admitted;
    await vi.advanceTimersByTimeAsync(0);
    expect(log.mock.calls.flat()).toEqual(['draining', 'drain_timeout']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('tracked callback failures retain their rejection without blocking settled drain forever', async () => {
    const { lifecycle, http, job } = setup();
    const failure = new Error('fake callback failure');
    await expect(
      lifecycle.runJob(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const stop = lifecycle.shutdown();
    http.release();
    job.release();
    expect(await stop).toBe(0); // lifecycle completion, not payment success
    expect(() => lifecycle.runJob(async () => {})).toThrow(LifecycleAdmissionClosedError);
  });

  it('startup failure drains partial resources but never reports clean completion', async () => {
    const { lifecycle, http, job, log } = setup();
    const stop = lifecycle.failStartup();
    http.release();
    job.release();
    expect(await stop).toBe(1);
    expect(log.mock.calls.flat()).toEqual(['draining', 'startup_failed']);
  });

  it('requires a listening server and finished registration to become ready', () => {
    const lifecycle = createServerLifecycle({
      boss: { offWork: async () => {}, stop: async () => {} },
      queues: [],
      log: () => {},
      exit: () => {},
    });
    expect(lifecycle.markReady()).toBe(false);
  });
});

describe('source-only platform lifecycle contract', () => {
  const appRoot = new URL('../../../apps/eunenem-server/', import.meta.url);
  it('native readiness healthcheck and grace exceed finite app cutoff, not Dokploy DONE', () => {
    const compose = readFileSync(new URL('docker-compose.platform.yml', appRoot), 'utf8');
    const graceSeconds = Number(compose.match(/stop_grace_period:\s*(\d+)s/)?.[1]);
    expect(graceSeconds * 1000).toBeGreaterThan(DRAIN_DEADLINE_MS);
    expect(compose).toContain('healthcheck:');
    expect(compose).toContain("fetch('http://127.0.0.1:3001/healthz'");
    expect(compose).toContain('r.status === 200 ? 0 : 1');
    expect(compose).toContain('AbortSignal.timeout(2000)');
    expect(compose).toContain(
      'command: ["node", "--import", "tsx", "--env-file-if-exists=.env", "server.tsx"]',
    );
    expect(compose).toContain('Dokploy DONE is not readiness');
  });

  it('keeps instrumentation first and admission before ALL request handlers; workers before listen', () => {
    const source = readFileSync(new URL('server.tsx', appRoot), 'utf8');
    expect(source.startsWith("import './src/lib/glitchtip/instrument.js';")).toBe(true);
    for (const marker of [
      "app.use('*', lifecycle.admissionMiddleware)",
      'createRequestObservabilityMiddleware({',
      'lifecycle.installSignalHandlers()',
      'await lifecycle.startupStep',
      'registerPixCobrancaReconciliationJob(deps.boss, deps, lifecycle)',
      'const httpServer = serve(',
    ]) {
      expect(source.indexOf(marker)).toBeGreaterThanOrEqual(0);
    }
    expect(source.indexOf("app.use('*', lifecycle.admissionMiddleware)")).toBeLessThan(
      source.indexOf('createRequestObservabilityMiddleware({'),
    );
    expect(source.indexOf('lifecycle.installSignalHandlers()')).toBeLessThan(
      source.indexOf('await lifecycle.startupStep'),
    );
    expect(
      source.indexOf('registerPixCobrancaReconciliationJob(deps.boss, deps, lifecycle)'),
    ).toBeLessThan(source.indexOf('const httpServer = serve('));
    expect(source).toContain('lifecycle.attachServer(httpServer)');
    expect(source).toContain('if (!lifecycle.markReady()) return;');
    const entrypoint = readFileSync(new URL('docker-entrypoint.sh', appRoot), 'utf8');
    expect(entrypoint).toContain("trap 'exit 143' TERM");
    expect(entrypoint.indexOf('pnpm db:migrate )')).toBeLessThan(entrypoint.indexOf('\nexec "$@"'));
  });
});
