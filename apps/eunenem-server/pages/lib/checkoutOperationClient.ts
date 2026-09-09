interface CheckoutOperationStorage {
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
  constructor() {
    super("checkout_operation_storage_unavailable");
    this.name = "CheckoutOperationStorageUnavailableError";
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
