import { describe, expect, it } from 'vitest';
import {
  CheckoutOperationStorageUnavailableError,
  checkoutRequestStorageKey,
  clearPendingCheckoutOperation,
  executeRecoverableCheckout,
  getOrCreatePendingCheckoutOperation,
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
