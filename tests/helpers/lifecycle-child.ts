// Offline child fixture only: real local HTTP + installed pg-boss polling loop,
// fake fetch/job I/O. Never imports application composition/env/provider/DB.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { createServerLifecycle } from '../../apps/eunenem-server/server/lifecycle.js';

const requireApp = createRequire(
  new URL('../../apps/eunenem-server/package.json', import.meta.url),
);
const { serve } = await import(pathToFileURL(requireApp.resolve('@hono/node-server')).href);
const { default: Worker } = await import(
  pathToFileURL(join(dirname(requireApp.resolve('pg-boss')), 'worker.js')).href
);
const send = (event: string, data = {}) => process.send?.({ event, ...data });
let releaseHttp!: () => void;
const blockedHttp = new Promise<void>((resolve) => {
  releaseHttp = resolve;
});
let releaseJob!: () => void;
const blockedJob = new Promise<void>((resolve) => {
  releaseJob = resolve;
});
let releaseStartup!: () => void;
const blockedStartup = new Promise<void>((resolve) => {
  releaseStartup = resolve;
});
const mode = process.argv[2];
let stopCount = 0;
let polls = 0;
const worker = new Worker({
  id: 'fake',
  name: 'jobs',
  options: {},
  resolveInterval: () => 10_000,
  fetch: async () => {
    polls += 1;
    send('poll', { polls });
    return [{ id: 'fake' }];
  },
  onFetch: () =>
    lifecycle.runJob(async () => {
      send('job_started');
      await blockedJob;
      send('job_completed');
    }),
  onError: () => send('worker_error'),
});
const lifecycle = createServerLifecycle({
  boss: {
    offWork: async () => {
      void worker.stop();
      send('polling_stopped');
    },
    stop: async () => {
      stopCount += 1;
      send('boss_stop', { stopCount });
      await worker.runPromise;
    },
  },
  queues: ['jobs'],
  deadlineMs: mode === 'timeout' || mode === 'startup-timeout' ? 200 : 5_000,
  log: (event) => send(event),
  exit: (code) => {
    // IPC callback is only for deterministic delivery of the test receipt.
    process.send?.({ event: 'exit', code, polls, stopCount }, () => process.exit(code));
  },
});
lifecycle.installSignalHandlers();
process.on('message', (message) => {
  if (message === 'release-http') releaseHttp();
  if (message === 'release-job') releaseJob();
  if (message === 'release-startup') releaseStartup();
  if (message === 'inspect-admission') {
    send('admission', { ready: lifecycle.ready });
  }
});

if (mode === 'startup-timeout') {
  send('starting');
  await lifecycle.startupStep(() => blockedStartup);
}
worker.start();
const app = new Hono();
app.use('*', lifecycle.admissionMiddleware);
app.get('/healthz', (c) => c.text('ok'));
app.get('/blocked', async (c) => {
  send('http_started');
  await blockedHttp;
  send('http_completed');
  return c.text('completed');
});
app.all('*', (c) => {
  send('business_admitted');
  return c.text('business');
});
const server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
  (info: { port: number }) => {
    if (lifecycle.markReady()) send('ready', { port: info.port, pid: process.pid });
  },
);
let closeCount = 0;
const close = server.close.bind(server);
server.close = (...args: unknown[]) => {
  closeCount += 1;
  send('http_close', { closeCount });
  return close(...args);
};
lifecycle.attachServer(server);
