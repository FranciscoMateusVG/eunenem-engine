import { describe, expect, it, vi } from 'vitest';
import {
  CheckoutOperationStorageUnavailableError,
  checkoutRequestStorageKey,
  clearPendingCheckoutOperation,
  executeRecoverableCheckout,
  getOrCreatePendingCheckoutOperation,
  setCheckoutFailureReporter,
} from '../../../apps/eunenem-server/pages/lib/checkoutOperationClient.js';

class StorageMemory {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('checkout operation client recovery identity', () => {
  it('reuses the pending operation through a reload and clears only the matching success', () => {
    const storage = new StorageMemory();
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    let cursor = 0;
    const createId = () => ids[cursor++] ?? 'unexpected';

    const first = getOrCreatePendingCheckoutOperation('checkout', storage, createId);
    const afterReload = getOrCreatePendingCheckoutOperation('checkout', storage, createId);
    expect(afterReload).toBe(first);

    clearPendingCheckoutOperation('checkout', '00000000-0000-4000-8000-999999999999', storage);
    expect(getOrCreatePendingCheckoutOperation('checkout', storage, createId)).toBe(first);

    clearPendingCheckoutOperation('checkout', first, storage);
    expect(getOrCreatePendingCheckoutOperation('checkout', storage, createId)).toBe(ids[1]);
  });

  it('fails closed before creating an operation when browser storage is unavailable', () => {
    expect(() =>
      getOrCreatePendingCheckoutOperation(
        'checkout',
        undefined,
        () => '00000000-0000-4000-8000-000000000003',
      ),
    ).toThrow(CheckoutOperationStorageUnavailableError);
  });

  it('fails closed when storage discards or throws on the identity write', () => {
    const discards = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() =>
      getOrCreatePendingCheckoutOperation(
        'checkout',
        discards,
        () => '00000000-0000-4000-8000-000000000003',
      ),
    ).toThrow(CheckoutOperationStorageUnavailableError);

    const throws = {
      getItem: () => null,
      setItem: () => {
        throw new Error('sentinel storage failure');
      },
      removeItem: () => {},
    };
    expect(() =>
      getOrCreatePendingCheckoutOperation(
        'checkout',
        throws,
        () => '00000000-0000-4000-8000-000000000004',
      ),
    ).toThrow(CheckoutOperationStorageUnavailableError);
  });
});

it('scopes canonical request identity without storing raw contributor fields; preserves legacy UUID', async () => {
  const storage = new StorageMemory();
  const first = {
    metodo: 'pix',
    valor: 1000,
    contribuinte: { nome: 'Guest', email: 'private@example.test' },
    itens: [{ id: 'a', quantidade: 1 }],
  };
  const key = await checkoutRequestStorageKey('cart', first, storage);
  expect(
    await checkoutRequestStorageKey(
      'cart',
      { ...first, contribuinte: { email: 'private@example.test', nome: 'Guest' } },
      storage,
    ),
  ).toBe(key);
  for (const changed of [
    { ...first, metodo: 'credit_card' },
    { ...first, valor: 2000 },
    { ...first, itens: [{ id: 'a', quantidade: 2 }] },
    { ...first, contribuinte: { nome: 'Other', email: 'other@example.test' } },
  ]) {
    expect(await checkoutRequestStorageKey('cart', changed, storage)).not.toBe(key);
  }
  expect(key).toMatch(/^cart:v2:[a-f0-9]{64}$/);
  storage.setItem('cart', '00000000-0000-4000-8000-000000000001');
  expect(await checkoutRequestStorageKey('cart', first, storage)).toBe('cart');
  expect(
    await checkoutRequestStorageKey('cart', { ...first, metodo: 'credit_card' }, storage),
  ).toBe('cart');
});
it('concurrent identical failures and reload keep the same ID; method switch keeps both pending identities', async () => {
  const storage = new StorageMemory();
  const sent: Array<{ operationId: string; metodo: string }> = [];
  const request = async (input: { operationId: string; metodo: string }) => {
    sent.push(input);
    throw new Error('response lost');
  };
  const run = (metodo: string) =>
    executeRecoverableCheckout({ storageKey: 'cart', storage, requestInput: { metodo }, request });
  await Promise.allSettled([run('pix'), run('pix')]);
  await expect(run('credit_card')).rejects.toThrow('response lost');
  await expect(run('pix')).rejects.toThrow('response lost');
  expect(new Set(sent.filter((v) => v.metodo === 'pix').map((v) => v.operationId)).size).toBe(1);
  expect(sent[2]?.operationId).not.toBe(sent[0]?.operationId);
});

it('k0tg1: explicit abandoned reply rotates only next action; double click shares work', async () => {
  const storage = new StorageMemory();
  const createId = vi
    .fn()
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000011')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000012');
  let fail = true;
  const ids: string[] = [];
  const request = vi.fn(async (input: { operationId: string }) => {
    ids.push(input.operationId);
    return fail
      ? { tipo: 'retry_new_operation', operationId: input.operationId }
      : { tipo: 'pix_qr' };
  });
  const args = { storageKey: 'k0tg1', requestInput: {}, storage, createId, request };
  const result = await Promise.allSettled([
    executeRecoverableCheckout(args),
    executeRecoverableCheckout(args),
  ]);
  expect(result.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  expect(request).toHaveBeenCalledTimes(1);
  await expect(executeRecoverableCheckout(args)).rejects.toThrow('Aguarde');
  expect(request).toHaveBeenCalledTimes(1);
  fail = false;
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
  try {
    await expect(executeRecoverableCheckout(args)).resolves.toEqual({ tipo: 'pix_qr' });
  } finally {
    vi.restoreAllMocks();
  }
  expect(ids[0]).not.toBe(ids[1]);
});

it('hdg7h: exposes exact cooldown and code without a server call, then permits retry', async () => {
  const storage = new StorageMemory();
  const input = { metodo: 'pix', valor: 3161 };
  const key = await checkoutRequestStorageKey('hdg7h', input, storage);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  storage.setItem(`${key}:retryAt`, String(now + 5000));
  const request = vi.fn(async () => ({ tipo: 'pix_qr' }));
  const args = { storageKey: 'hdg7h', requestInput: input, storage, request };
  try {
    await expect(executeRecoverableCheckout(args)).rejects.toMatchObject({
      code: 'CHECKOUT_COOLDOWN',
      retryAt: now + 5000,
      message: 'Aguarde 5 s antes de tentar novamente.',
    });
    expect(request).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    await expect(executeRecoverableCheckout(args)).resolves.toEqual({ tipo: 'pix_qr' });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
  }
});

describe('checkout failure reporting (aperture-zlkbo)', () => {
  const PII = 'customer@example.com';
  const STORAGE_MESSAGE =
    'Não foi possível acessar o armazenamento desta aba. Habilite o armazenamento do navegador e tente novamente.';
  const throwingStorage = () => ({
    getItem: (): string | null => {
      throw new Error(PII);
    },
    setItem: (): void => {
      throw new Error(PII);
    },
    removeItem: (): void => {
      throw new Error(PII);
    },
  });

  async function run(input: {
    storage?: object;
    request?: (value: { operationId: string }) => Promise<{ tipo: string }>;
    createId?: () => string;
    requestInput?: Record<string, unknown>;
  }) {
    const report = vi.fn();
    const request = vi.fn(input.request ?? (async () => ({ tipo: 'pix_qr' })));
    setCheckoutFailureReporter(report);
    try {
      const error = await executeRecoverableCheckout({
        storageKey: `secret-slug-${PII}`,
        requestInput: input.requestInput ?? { metodo: 'pix', slug: 'secret-slug' },
        request,
        storage: (input.storage ?? new StorageMemory()) as StorageMemory,
        createId: input.createId ?? (() => '00000000-0000-4000-8000-000000000099'),
      }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      return { report, request, error };
    } finally {
      setCheckoutFailureReporter(undefined);
    }
  }

  it('reports a sessionStorage failure once as storage_unavailable, banner error unchanged', async () => {
    const { error, report, request } = await run({ storage: throwingStorage() });
    expect(error).toBeInstanceOf(CheckoutOperationStorageUnavailableError);
    expect((error as Error).message).toBe(STORAGE_MESSAGE);
    expect(request).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toEqual({
      category: 'storage_unavailable',
      step: 'local',
      method: 'pix',
      operationKey: expect.stringMatching(/^op:[0-9a-f]{32}$/),
    });
    const serialized = JSON.stringify(report.mock.calls);
    expect(serialized).not.toContain(PII);
    expect(serialized).not.toContain('secret-slug');
  });

  it('classifies a raw storage throw at the central catch, rethrowing the same error', async () => {
    const storage = new StorageMemory();
    const flaky = {
      getItem: (key: string) => {
        if (key.endsWith(':retryAt')) throw new Error(PII);
        return storage.getItem(key);
      },
      setItem: (key: string, value: string) => storage.setItem(key, value),
      removeItem: (key: string) => storage.removeItem(key),
    };
    const { error, report } = await run({ storage: flaky });
    expect((error as Error).message).toBe(PII);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'storage_unavailable', step: 'local' }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(PII);
  });

  it('reports crypto.subtle and randomUUID failures as crypto_unavailable, banner error unchanged', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error(PII));
    try {
      const { error, report } = await run({});
      expect(error).toBeInstanceOf(CheckoutOperationStorageUnavailableError);
      expect((error as { code?: string }).code).toBe('CHECKOUT_STORAGE_UNAVAILABLE');
      expect((error as Error).message).toBe(STORAGE_MESSAGE);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'crypto_unavailable', step: 'local' }),
      );
    } finally {
      digest.mockRestore();
    }

    const noUuid = await run({
      createId: () => {
        throw new TypeError(PII);
      },
    });
    expect(noUuid.error).toBeInstanceOf(CheckoutOperationStorageUnavailableError);
    expect((noUuid.error as Error).message).toBe(STORAGE_MESSAGE);
    expect(noUuid.request).not.toHaveBeenCalled();
    expect(noUuid.report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'crypto_unavailable', step: 'local' }),
    );
  });

  it('reports a tRPC rejection once as trpc_<code> on the prepare step', async () => {
    const trpcError = Object.assign(new Error(PII), {
      name: 'TRPCClientError',
      data: { code: 'CONFLICT' },
    });
    const { error, report } = await run({
      request: async () => {
        throw trpcError;
      },
      requestInput: { metodo: 'credit_card' },
    });
    expect(error).toBe(trpcError);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'trpc_conflict', step: 'prepare', method: 'card' }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(PII);
  });

  it('dedupes concurrent submits of the same operation into one report', async () => {
    const report = vi.fn();
    setCheckoutFailureReporter(report);
    let reject!: (error: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise<{ tipo: string }>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const args = {
      storageKey: 'dedupe',
      requestInput: { metodo: 'pix' },
      storage: new StorageMemory(),
      request,
      createId: () => '00000000-0000-4000-8000-000000000098',
    };
    try {
      const first = executeRecoverableCheckout(args);
      const second = executeRecoverableCheckout(args);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      reject({ data: { code: 'INTERNAL_SERVER_ERROR' } });
      await Promise.allSettled([first, second]);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'trpc_internal_server_error' }),
      );
    } finally {
      setCheckoutFailureReporter(undefined);
    }
  });

  it('classifies network, confirm-step, cooldown and unknown failures', async () => {
    const network = await run({
      request: async () => {
        throw Object.assign(new Error('Failed to fetch'), {
          name: 'TRPCClientError',
          cause: new TypeError('Failed to fetch'),
        });
      },
    });
    expect(network.report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'network', step: 'prepare' }),
    );

    let calls = 0;
    const confirm = await run({
      request: async () => {
        calls += 1;
        if (calls === 1) return { tipo: 'prepared' };
        throw { data: { code: 'NOT_A_REAL_CODE' } };
      },
    });
    expect(confirm.report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'unknown', step: 'confirm' }),
    );

    const cooldown = await run({ request: async () => ({ tipo: 'retry_new_operation' }) });
    expect(cooldown.report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'cooldown', step: 'result' }),
    );

    const unconfirmed = await run({ request: async () => ({ tipo: 'prepared' }) });
    expect(unconfirmed.report).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'unknown', step: 'result' }),
    );
  });

  it('does not report a successful checkout', async () => {
    const { error, report } = await run({});
    expect(error).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it('never lets a throwing reporter change the checkout failure', async () => {
    setCheckoutFailureReporter(() => {
      throw new Error('reporter down');
    });
    try {
      await expect(
        executeRecoverableCheckout({
          storageKey: 'reporter',
          requestInput: { metodo: 'pix' },
          storage: new StorageMemory(),
          request: async () => {
            throw { data: { code: 'BAD_REQUEST' } };
          },
          createId: () => '00000000-0000-4000-8000-000000000097',
        }),
      ).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } });
    } finally {
      setCheckoutFailureReporter(undefined);
    }
  });
});
