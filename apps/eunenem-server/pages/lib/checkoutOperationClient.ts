import {
  type CheckoutFailureCategory,
  type CheckoutFailureMethod,
  type CheckoutFailureReport,
  type CheckoutFailureStep,
  checkoutFailureTrpcCategory,
} from './browser-error-contract.js';

export interface CheckoutOperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserSessionStorage(): CheckoutOperationStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export class CheckoutOperationStorageUnavailableError extends Error {
  readonly code = "CHECKOUT_STORAGE_UNAVAILABLE";
  /**
   * Monitoring-only cause. The guest-facing message, name and code stay the
   * same whether storage or the browser crypto API was the missing piece.
   */
  constructor(readonly reason: "storage" | "crypto" = "storage") {
    super("Não foi possível acessar o armazenamento desta aba. Habilite o armazenamento do navegador e tente novamente.");
    this.name = "CheckoutOperationStorageUnavailableError";
  }
}

export class CheckoutCooldownError extends Error {
  readonly code = "CHECKOUT_COOLDOWN";
  constructor(readonly retryAt: number) {
    super(`Aguarde ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} s antes de tentar novamente.`);
    this.name = "CheckoutCooldownError";
  }
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 128-bit non-cryptographic hash (four seeded 32-bit lanes) for the opaque,
 * in-memory monitoring dedupe key: the storage key never reaches a report.
 */
function localHash(text: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => {
      let h = seed >>> 0;
      for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 0x5bd1e995);
        h ^= h >>> 15;
      }
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      h ^= h >>> 16;
      return (h >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

/**
 * Keep the public operation identity stable through a rerender/reload. The ID
 * is not authority: the server still requires its HttpOnly capability cookie
 * and keyed request digest before any provider I/O.
 */
export function getOrCreatePendingCheckoutOperation(
  storageKey: string,
  storage = browserSessionStorage(),
  createId: () => string = () => crypto.randomUUID(),
): string {
  if (!storage) throw new CheckoutOperationStorageUnavailableError();
  let existing: string | null;
  try {
    existing = storage.getItem(storageKey);
  } catch {
    throw new CheckoutOperationStorageUnavailableError();
  }
  if (existing) {
    if (!OPERATION_ID.test(existing)) throw new CheckoutOperationStorageUnavailableError();
    return existing;
  }
  let operationId: string;
  try {
    operationId = createId();
  } catch {
    throw new CheckoutOperationStorageUnavailableError("crypto");
  }
  if (!OPERATION_ID.test(operationId)) throw new CheckoutOperationStorageUnavailableError("crypto");
  try {
    storage.setItem(storageKey, operationId);
    // A storage implementation can silently discard writes (privacy mode,
    // quota wrappers). The operation must be recoverable before the first
    // prepare request is allowed to reserve it.
    if (storage.getItem(storageKey) !== operationId) {
      throw new CheckoutOperationStorageUnavailableError();
    }
    return operationId;
  } catch {
    throw new CheckoutOperationStorageUnavailableError();
  }
}

export function clearPendingCheckoutOperation(
  storageKey: string,
  operationId: string,
  storage = browserSessionStorage(),
): void {
  try {
    if (storage?.getItem(storageKey) === operationId) storage.removeItem(storageKey);
  } catch {
    // A blocked storage API must not change checkout authorization semantics.
  }
}

/** Versioned request identity, not authorization (server HMAC remains authoritative).
 * Old bare UUIDs have no request fingerprint: keep their conservative recovery
 * behavior until the tab closes; never silently discard an ambiguous payment.
 *
 * A `crypto.subtle` failure keeps the same guest-facing error; only its
 * monitoring reason says crypto instead of storage.
 */
export async function checkoutRequestStorageKey(
  baseKey: string,
  requestInput: object,
  storage = browserSessionStorage(),
): Promise<string> {
  if (!storage) throw new CheckoutOperationStorageUnavailableError();
  let canonical: string;
  try {
    if (storage.getItem(baseKey) !== null) return baseKey;
    canonical = JSON.stringify(requestInput, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      }
      return value;
    });
  } catch {
    throw new CheckoutOperationStorageUnavailableError();
  }
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    return `${baseKey}:v2:${hash}`;
  } catch {
    throw new CheckoutOperationStorageUnavailableError("crypto");
  }
}

// ── Handled-failure monitoring (aperture-zlkbo) ───────────────────────────

type CheckoutFailureReporter = (report: CheckoutFailureReport) => void;
let checkoutFailureReporter: CheckoutFailureReporter | undefined;

/** Wired once at client bootstrap to the closed browser error capture. */
export function setCheckoutFailureReporter(reporter: CheckoutFailureReporter | undefined): void {
  checkoutFailureReporter = reporter;
}

function checkoutFailureMethod(requestInput: object): CheckoutFailureMethod {
  return (requestInput as { metodo?: unknown }).metodo === 'pix' ? 'pix' : 'card';
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  // A TRPCClientError without a tRPC `data.code` never got a tRPC response
  // (fetch failure, abort, non-JSON gateway page).
  return name === 'TRPCClientError' || name === 'AbortError' || cause instanceof TypeError;
}

/** Finite category from the error shape only; the message is never read. */
function classifyCheckoutFailure(error: unknown, storageThrew: boolean): CheckoutFailureCategory {
  if (error instanceof CheckoutCooldownError) return 'cooldown';
  if (error instanceof CheckoutOperationStorageUnavailableError) {
    return error.reason === 'crypto' ? 'crypto_unavailable' : 'storage_unavailable';
  }
  if (storageThrew) return 'storage_unavailable';
  if (typeof error === 'object' && error !== null) {
    const data = (error as { data?: unknown }).data;
    const code = typeof data === 'object' && data !== null ? (data as { code?: unknown }).code : undefined;
    const trpc = checkoutFailureTrpcCategory(code);
    if (trpc) return trpc;
  }
  return isNetworkFailure(error) ? 'network' : 'unknown';
}

/** Rethrows the exact storage error, remembering that storage was the cause. */
function observedStorage(storage: CheckoutOperationStorage, onThrow: () => void): CheckoutOperationStorage {
  const guard = <T>(call: () => T): T => {
    try {
      return call();
    } catch (error) {
      onThrow();
      throw error;
    }
  };
  return {
    getItem: (key) => guard(() => storage.getItem(key)),
    setItem: (key, value) => guard(() => storage.setItem(key, value)),
    removeItem: (key) => guard(() => storage.removeItem(key)),
  };
}

interface PreparedCheckoutResult {
  readonly tipo: "prepared" | "retry_new_operation";
}
/** A failure shared by concurrent submits of one operation is reported once. */
const reportedFailures = new WeakSet<object>();
const activeRequests = new WeakMap<CheckoutOperationStorage, Map<string, Promise<unknown>>>();

/**
 * Exact two-request orchestration used by the public checkout hooks.
 *
 * The operation id is persisted and read back before the first request. A
 * response lost after provider acceptance therefore leaves the same id for a
 * reload. Only a response received by this caller clears the tab-local id;
 * the HttpOnly capability has a separate business-terminal lifecycle owned by
 * the server.
 */
export async function executeRecoverableCheckout<
  TInput extends object,
  TResponse extends { readonly tipo: string },
>(input: {
  readonly storageKey: string;
  readonly requestInput: TInput;
  readonly request: (
    requestInput: TInput & { readonly operationId: string },
  ) => Promise<TResponse>;
  readonly storage?: CheckoutOperationStorage;
  readonly createId?: () => string;
}): Promise<Exclude<TResponse, PreparedCheckoutResult>> {
  // Every handled failure is reported here, once, as finite labels. The
  // rejection itself is rethrown untouched, so the guest-facing banner is
  // unchanged. The opaque operation key is a hash for in-memory dedupe.
  const method = checkoutFailureMethod(input.requestInput);
  let step: CheckoutFailureStep = 'local';
  let operationKey = `op:${localHash(input.storageKey)}`;
  let storageThrew = false;
  const reportFailure = (error: unknown): void => {
    if (typeof error === 'object' && error !== null) {
      if (reportedFailures.has(error)) return;
      reportedFailures.add(error);
    }
    try {
      checkoutFailureReporter?.({
        category: classifyCheckoutFailure(error, storageThrew),
        step,
        method,
        operationKey,
      });
    } catch {
      // Monitoring must never change the checkout outcome.
    }
  };

  try {
    const rawStorage = input.storage ?? browserSessionStorage();
    if (!rawStorage) throw new CheckoutOperationStorageUnavailableError();
    const storage = observedStorage(rawStorage, () => { storageThrew = true; });
    const storageKey = await checkoutRequestStorageKey(input.storageKey, input.requestInput, storage);
    operationKey = `op:${localHash(storageKey)}`;
    let active = activeRequests.get(rawStorage);
    if (!active) { active = new Map(); activeRequests.set(rawStorage, active); }
    const running = active.get(storageKey);
    if (running) return await (running as Promise<Exclude<TResponse, PreparedCheckoutResult>>);
    const perform = async (): Promise<Exclude<TResponse, PreparedCheckoutResult>> => {
      const retryAt = Number(storage.getItem(`${storageKey}:retryAt`) ?? 0);
      if (retryAt > Date.now()) throw new CheckoutCooldownError(retryAt);
      const operationId = getOrCreatePendingCheckoutOperation(storageKey, storage, input.createId);
      operationKey = `op:${localHash(`${storageKey}|${operationId}`)}`;
      const requestInput = { ...input.requestInput, operationId };
      step = 'prepare';
      let result = await input.request(requestInput);
      if (result.tipo === "prepared") {
        step = 'confirm';
        result = await input.request(requestInput);
      }
      step = 'result';
      if (result.tipo === "prepared") throw new Error("Checkout não confirmado");
      if (result.tipo === "retry_new_operation") {
        // This response is issued only after a server-side, locked abandonment.
        // Network errors never clear an ambiguous identity. No automatic reissue.
        const failures = Math.min(4, Number(storage.getItem(`${storageKey}:failures`) ?? 0) + 1);
        storage.setItem(`${storageKey}:failures`, String(failures));
        const nextRetryAt = Date.now() + Math.min(30000, 5000 * 2 ** (failures - 1));
        storage.setItem(`${storageKey}:retryAt`, String(nextRetryAt));
        clearPendingCheckoutOperation(storageKey, operationId, storage);
        throw new CheckoutCooldownError(nextRetryAt);
      }
      storage.removeItem(`${storageKey}:failures`);
      storage.removeItem(`${storageKey}:retryAt`);
      // A delivered QR remains bound to this identity, even after rerender/reload.
      if (result.tipo !== "pix_qr") clearPendingCheckoutOperation(storageKey, operationId, storage);
      return result as Exclude<TResponse, PreparedCheckoutResult>;
    };
    const promise = perform();
    active.set(storageKey, promise);
    try { return await promise; }
    finally { if (active.get(storageKey) === promise) active.delete(storageKey); }
  } catch (error) {
    reportFailure(error);
    throw error;
  }
}
