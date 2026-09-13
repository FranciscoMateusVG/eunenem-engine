import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const appDir = join(repo, 'apps/eunenem-server');
const appRequire = createRequire(join(appDir, 'package.json'));
const fixture = join(repo, 'tests/helpers/lifecycle-child.ts');
type Event = {
  event: string;
  port?: number;
  pid?: number;
  code?: number;
  polls?: number;
  stopCount?: number;
  ready?: boolean;
};
const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const scratch: string[] = [];

function start(mode: string, throughEntrypoint = false) {
  const args = ['--import', 'tsx', '--env-file-if-exists=.env', fixture, mode];
  let command = process.execPath;
  let argv = args;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' };
  if (throughEntrypoint) {
    // Exercise the real entrypoint and exec transition, with ONLY migration
    // invocation stubbed. No /app, real pnpm migration, DB or .env is touched.
    const dir = mkdtempSync(join(tmpdir(), 'eunenem-lifecycle-'));
    scratch.push(dir);
    writeFileSync(
      join(dir, 'pnpm'),
      mode === 'migration'
        ? '#!/bin/sh\necho migration_started\nsleep 0.2\nexit 0\n'
        : '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    );
    env.PATH = `${dir}:${env.PATH}`;
    command = '/bin/sh';
    argv = [
      '-c',
      'entrypoint=$1; shift; cd() { :; }; . "$entrypoint"',
      '--',
      join(appDir, 'docker-entrypoint.sh'),
      process.execPath,
      ...args,
    ];
  }
  // CWD is this clean worktree, not the canonical checkout with real .env.
  const child = spawn(command, argv, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  const events: Event[] = [];
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    if (chunk.toString().includes('migration_started')) events.push({ event: 'migration_started' });
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('message', (event) => events.push(event as Event));
  const exited = once(child, 'exit');
  const wait = async (event: string) => {
    await vi.waitFor(
      () => {
        if (child.exitCode !== null && !events.some((item) => item.event === event))
          throw new Error(`child exited: ${stderr}`);
        expect(events.some((item) => item.event === event)).toBe(true);
      },
      { timeout: 5_000, interval: 10 },
    );
    return events.find((item) => item.event === event) as Event;
  };
  return { child, events, exited, wait };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('offline real Hono signal drain through the native platform command', () => {
  it('SIGTERM reaches exec Node PID; pipelined accepted socket gets503 while admitted HTTP and job finish', async () => {
    const { child, events, exited, wait } = start('success', true);
    const ready = await wait('ready');
    expect(ready.pid).toBe(child.pid); // not a pnpm/tsx wrapper child
    await wait('job_started');
    const socket = createConnection({ host: '127.0.0.1', port: ready.port });
    sockets.push(socket);
    let wire = '';
    socket.on('data', (data) => {
      wire += data.toString();
    });
    await once(socket, 'connect');
    socket.write('GET /blocked HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await wait('http_started');
    child.kill('SIGTERM');
    await wait('polling_stopped');
    await wait('boss_stop');
    child.kill('SIGINT');
    child.send('inspect-admission');
    expect((await wait('admission')).ready).toBe(false);
    // The socket is busy with /blocked so server.close does not remove it.
    // A new pipelined request reaches the real earliest Hono middleware.
    socket.write(
      'POST /api/webhooks/stripe HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((event) => event.event === 'business_admitted')).toBe(false);
    expect(child.exitCode).toBeNull();
    child.send('release-http');
    await wait('http_completed');
    await vi.waitFor(() => expect(wire).toContain('503 Service Unavailable'));
    expect(wire).toContain('completed');
    expect(events.some((event) => event.event === 'drain_complete')).toBe(false);
    child.send('release-job');
    expect(await exited).toEqual([0, null]);
    expect(events.filter((event) => event.event === 'http_close')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'boss_stop')).toHaveLength(1);
    expect(events.find((event) => event.event === 'exit')).toMatchObject({
      code: 0,
      polls: 1,
      stopCount: 1,
    });
    expect(events.findIndex((event) => event.event === 'job_completed')).toBeLessThan(
      events.findIndex((event) => event.event === 'drain_complete'),
    );
  });

  it('TERM during the real entrypoint migration wait prevents later app startup', async () => {
    const { child, events, exited, wait } = start('migration', true);
    await wait('migration_started');
    child.kill('SIGTERM');
    expect(await exited).toEqual([143, null]);
    expect(events.some((event) => event.event === 'ready')).toBe(false);
  });

  it('disconnected client cannot make a still-running admitted handler look drained', async () => {
    const { child, events, exited, wait } = start('success');
    const ready = await wait('ready');
    const socket = createConnection({ host: '127.0.0.1', port: ready.port });
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write('GET /blocked HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await wait('http_started');
    socket.destroy();
    child.send('release-job');
    await wait('job_completed');
    child.kill('SIGTERM');
    await wait('boss_stop');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.exitCode).toBeNull();
    expect(events.some((event) => event.event === 'drain_complete')).toBe(false);
    child.send('release-http');
    expect(await exited).toEqual([0, null]);
    expect(events.findIndex((event) => event.event === 'http_completed')).toBeLessThan(
      events.findIndex((event) => event.event === 'drain_complete'),
    );
  });

  it('blocked fake work exceeds app deadline: actual child exits1 without success', async () => {
    const { child, events, exited, wait } = start('timeout');
    await wait('ready');
    await wait('job_started');
    child.kill('SIGTERM');
    await wait('draining');
    child.kill('SIGTERM');
    expect(await exited).toEqual([1, null]);
    expect(events.some((event) => event.event === 'drain_timeout')).toBe(true);
    expect(events.some((event) => event.event === 'drain_complete')).toBe(false);
    expect(events.find((event) => event.event === 'exit')).toMatchObject({
      code: 1,
      polls: 1,
      stopCount: 1,
    });
  });

  it('signal while startup is blocked never emits ready; deadline remains active', async () => {
    const { child, events, exited, wait } = start('startup-timeout');
    await wait('starting');
    child.kill('SIGTERM');
    expect(await exited).toEqual([1, null]);
    expect(events.some((event) => event.event === 'ready')).toBe(false);
    expect(events.some((event) => event.event === 'drain_complete')).toBe(false);
    expect(events.some((event) => event.event === 'drain_timeout')).toBe(true);
  });
});

describe('installed pg-boss polling contract, fake fetch only', () => {
  it('stop flips polling off synchronously but awaits an already-issued fetch AND its handler', async () => {
    const { default: Worker } = await import(
      pathToFileURL(join(dirname(appRequire.resolve('pg-boss')), 'worker.js')).href
    );
    const { default: Manager } = await import(
      pathToFileURL(join(dirname(appRequire.resolve('pg-boss')), 'manager.js')).href
    );
    const executeSql = vi.fn(() => {
      throw new Error('database_forbidden');
    });
    const manager = new Manager({ executeSql }, {});
    let returnFetch!: (jobs: unknown[]) => void;
    const fetched = new Promise((resolve) => {
      returnFetch = resolve;
    });
    let releaseJob!: () => void;
    const job = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    const fetch = vi.fn(() => fetched);
    const onFetch = vi.fn(() => job);
    const worker = new Worker({
      id: 'fake',
      name: 'fake',
      options: {},
      fetch,
      onFetch,
      onError: vi.fn(),
      resolveInterval: () => 0,
    });
    manager.workers.set(worker.id, worker);
    worker.start();
    const stopped = vi.fn();
    const offWork = manager.offWork('fake', { wait: false });
    const stop = worker.runPromise.then(stopped);
    expect(worker.stopping).toBe(true);
    await offWork;
    expect(manager.hasPendingCleanups()).toBe(true);
    // Full native manager.stop must retain the earlier offWork cleanup.
    await manager.stop();
    expect(manager.hasPendingCleanups()).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    returnFetch([{ id: 'already-fetching' }]);
    await vi.waitFor(() => expect(onFetch).toHaveBeenCalledOnce());
    expect(stopped).not.toHaveBeenCalled();
    releaseJob();
    await stop;
    expect(fetch).toHaveBeenCalledOnce();
    expect(worker.stopped).toBe(true);
    await vi.waitFor(() => expect(manager.hasPendingCleanups()).toBe(false));
    expect(executeSql).not.toHaveBeenCalled();
  });
});
