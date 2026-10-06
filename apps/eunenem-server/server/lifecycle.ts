import type { ServerType } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';

// A best-effort drain budget, NOT a bound on provider/bank convergence. Current
// Stripe retries alone can consume 360s plus overhead; this is not a proven
// wall-clock bound on all admitted work/DB waits. Financial/migration releases
// still need maintenance review. Docker must allow longer than this deadline
// before sending SIGKILL.
export const DRAIN_DEADLINE_MS = 420_000;

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'closed' | 'failed';
export type LifecycleEvent =
  | 'draining'
  | 'drain_complete'
  | 'drain_timeout'
  | 'http_close_failed'
  | 'boss_stop_failed'
  | 'startup_failed'
  | 'http_server_failed';

interface DrainBoss {
  offWork(name: string, options: { wait: false }): Promise<void>;
  stop(options: { graceful: true; timeout: number }): Promise<void>;
}

export class LifecycleAdmissionClosedError extends Error {
  constructor() {
    super('server_admission_closed');
  }
}

export function createServerLifecycle(options: {
  boss: DrainBoss;
  queues: readonly string[];
  log: (event: LifecycleEvent) => void;
  exit: (code: number) => void;
  deadlineMs?: number;
}) {
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('invalid_drain_deadline');
  }
  let state: LifecycleState = 'starting';
  let server: ServerType | undefined;
  let startupOperation: Promise<unknown> | undefined;
  let shutdownTask: Promise<number> | undefined;
  let failure:
    | 'startup_failed'
    | 'http_server_failed'
    | 'http_close_failed'
    | 'boss_stop_failed'
    | undefined;
  const admittedWork = new Set<Promise<void>>();

  // Workers may run during registration, but may not begin a new business
  // callback after draining. An already-issued pg-boss SQL fetch can still
  // return after offWork: that is not an atomic database admission barrier.
  function assertAdmissionOpen() {
    if (state !== 'starting' && state !== 'ready') {
      throw new LifecycleAdmissionClosedError();
    }
  }

  const admissionMiddleware: MiddlewareHandler = async (c, next) => {
    if (state !== 'ready') {
      c.header('Connection', 'close');
      c.header('Retry-After', '1');
      return c.text('unavailable', 503);
    }
    // A disconnected client can let server.close finish while its async
    // handler still runs. Track handler settlement independently of sockets.
    let settled!: () => void;
    const completed = new Promise<void>((resolve) => {
      settled = resolve;
    });
    admittedWork.add(completed);
    try {
      await next();
    } finally {
      admittedWork.delete(completed);
      settled();
    }
  };

  function shutdown(): Promise<number> {
    if (shutdownTask) return shutdownTask;
    state = 'draining'; // Before ANY asynchronous stop/close or logging.
    const drainStartedAt = performance.now();
    let resolveTask!: (code: number) => void;
    shutdownTask = new Promise((resolve) => {
      resolveTask = resolve;
    });
    options.log('draining');
    let settled = false;
    const finish = (code: number, event: LifecycleEvent) => {
      if (settled) return;
      // A busy event loop can postpone a timer. Never report success after
      // the monotonic deadline just because its callback has not run yet.
      if (code === 0 && performance.now() - drainStartedAt >= deadlineMs) {
        code = 1;
        event = 'drain_timeout';
      }
      settled = true;
      clearTimeout(deadline);
      state = code === 0 ? 'closed' : 'failed';
      options.log(event);
      resolveTask(code);
      options.exit(code);
    };
    // Keep the timer referenced even if all other handles close prematurely.
    const deadline = setTimeout(() => finish(1, 'drain_timeout'), deadlineMs);

    const httpDrain = new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    }).catch(() => {
      // A close error is not permission to abandon other admitted work.
      failure ??= 'http_close_failed';
    });

    // pg-boss 12.26 stop() awaits notifier.stop() before stopping workers.
    // offWork(wait:false) calls worker.stop() synchronously (stopping=true),
    // stopping further polling without waiting for admitted handlers. The
    // already-issued fetch/handler is allowed to finish and is awaited by stop.
    function stopPolling() {
      return Promise.all(options.queues.map((name) => options.boss.offWork(name, { wait: false })));
    }
    const pendingStartup = startupOperation;
    const bossDrain = (async () => {
      await stopPolling();
      if (pendingStartup) {
        // A registration already in progress must settle before boss.stop;
        // otherwise a late worker could be installed behind the stop. Guarded
        // callbacks cannot begin business work after the admission boundary.
        await pendingStartup.catch(() => {});
        await stopPolling();
      }
      // Native timeout is milliseconds (min 1000) and expiry can silently
      // failWip then RESOLVE. Keep it beyond OUR nonzero deadline, so that a
      // forced pg-boss expiry can never be reported as graceful completion.
      await options.boss.stop({ graceful: true, timeout: deadlineMs + 1_000 });
    })().catch(() => {
      // Preserve failure but keep the other drains alive until settlement
      // or the common deadline; never exit early while effects may run.
      failure ??= 'boss_stop_failed';
    });

    // pg-boss may settle bookkeeping on job expiration while an advisory
    // AbortSignal does not stop the original JS callback. Wait for OUR admitted
    // callback promises too (and HTTP handlers surviving client disconnect);
    // native socket/worker bookkeeping alone is not completion.
    const workDrain = Promise.all([...admittedWork]);
    void Promise.all([httpDrain, bossDrain, workDrain]).then(() => {
      finish(failure ? 1 : 0, failure ?? 'drain_complete');
    });
    return shutdownTask;
  }

  return {
    get state() {
      return state;
    },
    get ready() {
      return state === 'ready';
    },
    admissionMiddleware,
    assertAdmissionOpen,
    runJob<T>(operation: () => Promise<T>): Promise<T> {
      assertAdmissionOpen();
      const result = operation();
      // Track settlement, not financial success; retain the original rejection
      // for pg-boss's unchanged error/retry policy.
      const completed = result.then(
        () => {},
        () => {},
      );
      admittedWork.add(completed);
      void completed.then(() => admittedWork.delete(completed));
      return result;
    },
    async startupStep<T>(operation: () => Promise<T>): Promise<T> {
      assertAdmissionOpen();
      const pending = operation();
      startupOperation = pending;
      try {
        const result = await pending;
        assertAdmissionOpen();
        return result;
      } finally {
        if (startupOperation === pending) startupOperation = undefined;
      }
    },
    attachServer(httpServer: ServerType) {
      assertAdmissionOpen();
      server = httpServer;
      server.on('error', () => {
        failure = 'http_server_failed';
        void shutdown();
      });
    },
    markReady() {
      if (state !== 'starting' || !server?.listening || startupOperation) return false;
      state = 'ready';
      return true;
    },
    failStartup() {
      failure = 'startup_failed';
      return shutdown();
    },
    shutdown,
    installSignalHandlers(signals: Pick<NodeJS.Process, 'on' | 'off'> = process) {
      const handle = () => {
        void shutdown();
      };
      signals.on('SIGTERM', handle);
      signals.on('SIGINT', handle);
      return () => {
        signals.off('SIGTERM', handle);
        signals.off('SIGINT', handle);
      };
    },
  };
}
