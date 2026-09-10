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

interface PreparedCheckoutResult {
  readonly tipo: "prepared";
}

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
  const operationId = getOrCreatePendingCheckoutOperation(
    input.storageKey,
    input.storage,
    input.createId,
  );
  const requestInput = { ...input.requestInput, operationId };
  const prepared = await input.request(requestInput);
  if (prepared.tipo !== "prepared") {
    clearPendingCheckoutOperation(input.storageKey, operationId, input.storage);
    return prepared as Exclude<TResponse, PreparedCheckoutResult>;
  }

  const result = await input.request(requestInput);
  if (result.tipo === "prepared") throw new Error("Checkout não confirmado");
  clearPendingCheckoutOperation(input.storageKey, operationId, input.storage);
  return result as Exclude<TResponse, PreparedCheckoutResult>;
}
