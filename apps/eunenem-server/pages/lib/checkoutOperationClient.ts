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
  try {
    const existing = storage?.getItem(storageKey);
    if (existing) return existing;
    const operationId = createId();
    storage?.setItem(storageKey, operationId);
    return operationId;
  } catch {
    // Storage is an optional recovery aid, never the authorization boundary.
    return createId();
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
