import {
  captureEvent,
  close,
  type ErrorEvent as SentryErrorEvent,
  init,
} from '@sentry/react';
import type { ErrorInfo } from 'react';
import {
  type BrowserErrorRuntimeConfig,
  validateBrowserErrorConfig,
} from './browser-error-contract.js';

export type BrowserErrorSource =
  | 'bootstrap'
  | 'window_error'
  | 'unhandled_rejection'
  | 'react_caught'
  | 'react_recoverable'
  | 'react_uncaught';

const SOURCE_TYPE: Readonly<Record<BrowserErrorSource, string>> = {
  bootstrap: 'BrowserBootstrapError',
  window_error: 'BrowserUnhandledError',
  unhandled_rejection: 'BrowserUnhandledRejection',
  react_caught: 'ReactCaughtError',
  react_recoverable: 'ReactRecoverableError',
  react_uncaught: 'ReactUncaughtError',
};

const ROUTE_KINDS = new Set([
  'landing',
  'campanhas',
  'pagina',
  'pagina-sucesso',
  'confirmar-presenca',
  'painel',
  'painel-convite-preview',
  'painel-section',
  'termos-de-uso',
  'trpc-smoke',
  'auth-demo',
  'faq',
  'admin',
  'admin-usuario',
  'admin-campanha',
  'admin-contribuicao',
  'admin-pagamento',
  'admin-pagamentos',
  'admin-repasses',
  'admin-catalogo',
  'admin-repasse-detail',
  'not-found',
]);

const MAX_DEDUPE_KEYS = 128;
const DEDUPE_TTL_MS = 5_000;
const MAX_PENDING_EVENTS = 32;
const PENDING_EVENT_TTL_MS = 30_000;
const MAX_STACK_BYTES = 16_384;
const MAX_FRAMES = 20;
const ALLOWED_ORIGINS = new Set(['https://eunenem.com', 'https://www.eunenem.com']);

type BrowserEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type SentryTransportFactory = NonNullable<Parameters<typeof init>[0]['transport']>;

interface SafeFrame {
  readonly filename: '[application-frame]' | '[client-bundle]';
  readonly lineno: number;
  readonly colno: number;
  readonly in_app: boolean;
}

interface CaptureOptions {
  readonly target?: BrowserEventTarget;
  readonly origin?: string;
  readonly transport?: SentryTransportFactory;
  readonly now?: () => number;
  readonly generateEventId?: () => string;
}

interface ClosedBrowserEvent {
  readonly eventId: string;
  readonly timestamp: number;
  readonly release: string;
  readonly source: BrowserErrorSource;
  readonly routeKind: string;
  readonly frames: readonly SafeFrame[];
}

export interface BrowserErrorCapture {
  readonly enabled: boolean;
  readonly onCaughtError: (error: unknown, info: ErrorInfo) => void;
  readonly onRecoverableError: (error: unknown, info: ErrorInfo) => void;
  readonly onUncaughtError: (error: unknown, info: ErrorInfo) => void;
  capture(source: BrowserErrorSource, error: unknown): void;
  setRouteKind(routeKind: string): void;
  dispose(): void;
}

function noOpCapture(): BrowserErrorCapture {
  const noOp = () => undefined;
  return {
    enabled: false,
    onCaughtError: noOp,
    onRecoverableError: noOp,
    onUncaughtError: noOp,
    capture: noOp,
    setRouteKind: noOp,
    dispose: noOp,
  };
}

function safePositiveInteger(value: string | undefined, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

export function safeBrowserFrames(error: unknown): SafeFrame[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
  const stack = error.stack.slice(0, MAX_STACK_BYTES);
  const frames: SafeFrame[] = [];

  for (const line of stack.split('\n').slice(1, 51)) {
    const match = line.match(/:(\d{1,7}):(\d{1,6})\)?$/);
    const lineno = safePositiveInteger(match?.[1], 1_000_000);
    const colno = safePositiveInteger(match?.[2], 100_000);
    if (lineno === null || colno === null) continue;
    const isClientBundle = /(?:^|\/)public\/client\.js(?::|\?|$)/.test(line);
    frames.push({
      filename: isClientBundle ? '[client-bundle]' : '[application-frame]',
      lineno,
      colno,
      in_app: isClientBundle,
    });
    if (frames.length === MAX_FRAMES) break;
  }

  return frames.reverse();
}

function safeEventId(generateEventId: () => string): string | null {
  try {
    const value = generateEventId().replaceAll('-', '');
    return /^[0-9a-f]{32}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function buildClosedEvent(input: ClosedBrowserEvent): SentryErrorEvent {
  const frames = input.frames.map((frame) => ({ ...frame }));
  return {
    type: undefined,
    event_id: input.eventId,
    timestamp: input.timestamp,
    level: 'error',
    platform: 'javascript',
    environment: 'production',
    release: input.release,
    tags: {
      error_source: input.source,
      route_kind: input.routeKind,
    },
    exception: {
      values: [
        {
          type: SOURCE_TYPE[input.source],
          value: 'Browser client failure',
          ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
        },
      ],
    },
  };
}

export function initializeBrowserErrorCapture(
  runtimeConfig: BrowserErrorRuntimeConfig | undefined,
  options: CaptureOptions = {},
): BrowserErrorCapture {
  const config = validateBrowserErrorConfig(runtimeConfig);
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window);
  const origin =
    options.origin ??
    (target && 'location' in target ? (target as Window).location.origin : undefined);
  if (!config || !target || !origin || !ALLOWED_ORIGINS.has(origin)) return noOpCapture();

  const pendingEvents = new Map<
    string,
    { readonly event: ClosedBrowserEvent; readonly expiresAt: number }
  >();
  try {
    const client = init({
      dsn: config.dsn,
      release: config.release,
      environment: 'production',
      defaultIntegrations: false,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      sendClientReports: false,
      ...(options.transport ? { transport: options.transport } : {}),
      beforeSend(event, hint) {
        hint.attachments = [];
        const eventId = event.event_id;
        if (!eventId) return null;
        const closedEvent = pendingEvents.get(eventId)?.event;
        pendingEvents.delete(eventId);
        return closedEvent ? buildClosedEvent(closedEvent) : null;
      },
    });
    if (!client) return noOpCapture();
  } catch {
    return noOpCapture();
  }

  const now = options.now ?? Date.now;
  const generateEventId = options.generateEventId ?? (() => globalThis.crypto.randomUUID());
  const seenObjects = new WeakSet<object>();
  const recentKeys = new Map<string, number>();
  let routeKind = 'not-found';

  const capture = (source: BrowserErrorSource, error: unknown): void => {
    try {
      if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
        const object = error as object;
        if (seenObjects.has(object)) return;
        seenObjects.add(object);
      }

      const frames = safeBrowserFrames(error);
      const currentTime = now();
      for (const [key, expiry] of recentKeys) {
        if (expiry <= currentTime) recentKeys.delete(key);
      }
      const lead = frames.at(-1);
      const dedupeKey = `${source}|${routeKind}|${lead?.filename ?? 'none'}|${lead?.lineno ?? 0}|${lead?.colno ?? 0}`;
      if (recentKeys.has(dedupeKey)) return;
      if (recentKeys.size >= MAX_DEDUPE_KEYS) {
        const oldest = recentKeys.keys().next().value;
        if (oldest !== undefined) recentKeys.delete(oldest);
      }
      recentKeys.set(dedupeKey, currentTime + DEDUPE_TTL_MS);

      for (const [eventId, pending] of pendingEvents) {
        if (pending.expiresAt <= currentTime) pendingEvents.delete(eventId);
      }
      if (pendingEvents.size >= MAX_PENDING_EVENTS) return;
      const eventId = safeEventId(generateEventId);
      if (!eventId) return;
      const event: ClosedBrowserEvent = {
        eventId,
        timestamp: currentTime / 1_000,
        release: config.release,
        source,
        routeKind,
        frames,
      };
      pendingEvents.set(eventId, { event, expiresAt: currentTime + PENDING_EVENT_TTL_MS });

      // beforeSend is the final SDK boundary. It replaces anything merged or
      // injected by ambient scopes/processors with the closure-owned event and
      // clears attachments, while leaving those ambient scopes untouched.
      captureEvent(buildClosedEvent(event));
    } catch {
      // Browser monitoring is fail-open for rendering and fail-closed for data.
    }
  };

  const onWindowError = (event: Event) => {
    const error =
      typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
        ? event.error
        : (event as Event & { readonly error?: unknown }).error;
    capture('window_error', error);
  };
  const onUnhandledRejection = (event: Event) => {
    const reason =
      typeof PromiseRejectionEvent !== 'undefined' && event instanceof PromiseRejectionEvent
        ? event.reason
        : (event as Event & { readonly reason?: unknown }).reason;
    capture('unhandled_rejection', reason);
  };
  try {
    target.addEventListener('error', onWindowError);
    target.addEventListener('unhandledrejection', onUnhandledRejection);
  } catch {
    for (const [type, listener] of [
      ['error', onWindowError],
      ['unhandledrejection', onUnhandledRejection],
    ] as const) {
      try {
        target.removeEventListener(type, listener);
      } catch {
        // Listener cleanup cannot be allowed to break application hydration.
      }
    }
    void close(0).catch(() => undefined);
    return noOpCapture();
  }

  return {
    enabled: true,
    onCaughtError: (error) => capture('react_caught', error),
    onRecoverableError: (error) => capture('react_recoverable', error),
    onUncaughtError: (error) => capture('react_uncaught', error),
    capture,
    setRouteKind(candidate) {
      routeKind = ROUTE_KINDS.has(candidate) ? candidate : 'not-found';
    },
    dispose() {
      target.removeEventListener('error', onWindowError);
      target.removeEventListener('unhandledrejection', onUnhandledRejection);
    },
  };
}
