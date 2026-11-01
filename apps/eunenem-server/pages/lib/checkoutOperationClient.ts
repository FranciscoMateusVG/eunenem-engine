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
  constructor() {
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
  try {
    const existing = storage.getItem(storageKey);
    if (existing) {
      if (!OPERATION_ID.test(existing)) throw new CheckoutOperationStorageUnavailableError();
      return existing;
    }
    const operationId = createId();
    if (!OPERATION_ID.test(operationId)) throw new CheckoutOperationStorageUnavailableError();
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
 */
export async function checkoutRequestStorageKey(
  baseKey: string,
  requestInput: object,
  storage = browserSessionStorage(),
): Promise<string> {
  if (!storage) throw new CheckoutOperationStorageUnavailableError();
  try {
    if (storage.getItem(baseKey) !== null) return baseKey;
    const canonical = JSON.stringify(requestInput, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      }
      return value;
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    return `${baseKey}:v2:${hash}`;
  } catch {
    throw new CheckoutOperationStorageUnavailableError();
  }
}

interface PreparedCheckoutResult {
  readonly tipo: "prepared" | "retry_new_operation";
}
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
  const storage = input.storage ?? browserSessionStorage();
  if (!storage) throw new CheckoutOperationStorageUnavailableError();
  const storageKey = await checkoutRequestStorageKey(input.storageKey, input.requestInput, storage);
  let active = activeRequests.get(storage);
  if (!active) { active = new Map(); activeRequests.set(storage, active); }
  const running = active.get(storageKey);
  if (running) return running as Promise<Exclude<TResponse, PreparedCheckoutResult>>;
  const perform = async (): Promise<Exclude<TResponse, PreparedCheckoutResult>> => {
    const retryAt = Number(storage.getItem(`${storageKey}:retryAt`) ?? 0);
    if (retryAt > Date.now()) throw new CheckoutCooldownError(retryAt);
    const operationId = getOrCreatePendingCheckoutOperation(storageKey, storage, input.createId);
    const requestInput = { ...input.requestInput, operationId };
    let result = await input.request(requestInput);
    if (result.tipo === "prepared") result = await input.request(requestInput);
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
}
