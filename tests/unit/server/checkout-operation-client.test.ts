import { describe, expect, it } from 'vitest';
import {
  clearPendingCheckoutOperation,
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

  it('still creates an operation when browser storage is unavailable', () => {
    expect(
      getOrCreatePendingCheckoutOperation(
        'checkout',
        undefined,
        () => '00000000-0000-4000-8000-000000000003',
      ),
    ).toBe('00000000-0000-4000-8000-000000000003');
  });
});
