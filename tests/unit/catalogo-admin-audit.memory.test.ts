import { describe, expect, it } from 'vitest';
import { CatalogoAdminAuditMemory } from '../../src/adapters/catalogo-admin-audit/catalogo-admin-audit.memory.js';

describe('CatalogoAdminAuditMemory', () => {
  it('appends immutable lifecycle events with JSON-safe metadata', async () => {
    const occurredAt = new Date('2026-07-27T12:00:00.000Z');
    const audit = new CatalogoAdminAuditMemory(() => occurredAt);
    const metadata = { changedFields: ['nome', 'precoCents'], count: 2 };

    await audit.append({
      requestId: '29bbfaac-4135-4618-8578-9c029e1a67da',
      actorUsuarioId: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.product.update',
      phase: 'requested',
      targetType: 'product',
      targetId: '8ab38d30-1434-41bd-8df0-fad6ff941c09',
      metadata,
    });

    metadata.changedFields.push('ativo');
    const firstRead = audit.events;
    expect(firstRead).toHaveLength(1);
    expect(firstRead[0]).toMatchObject({
      requestId: '29bbfaac-4135-4618-8578-9c029e1a67da',
      actorUsuarioId: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.product.update',
      phase: 'requested',
      targetType: 'product',
      targetId: '8ab38d30-1434-41bd-8df0-fad6ff941c09',
      metadata: { changedFields: ['nome', 'precoCents'], count: 2 },
      occurredAt,
    });
    expect(firstRead[0]?.id).toMatch(/^[0-9a-f-]{36}$/);

    // The read surface returns snapshots, not mutable handles into the store.
    const exposedMetadata = firstRead[0]?.metadata as {
      changedFields: string[];
    };
    exposedMetadata.changedFields.push('imageUrl');
    expect(audit.events[0]?.metadata).toEqual({
      changedFields: ['nome', 'precoCents'],
      count: 2,
    });
  });

  it('preserves multiple phases under the same request id in append order', async () => {
    const audit = new CatalogoAdminAuditMemory();
    const common = {
      requestId: '29bbfaac-4135-4618-8578-9c029e1a67da',
      actorUsuarioId: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.image.presign',
      targetType: 'product-image',
      targetId: null,
    } as const;

    await audit.append({ ...common, phase: 'requested', metadata: { sizeBytes: 4_096 } });
    await audit.append({ ...common, phase: 'succeeded', metadata: { extension: 'png' } });

    expect(audit.events.map(({ phase }) => phase)).toEqual(['requested', 'succeeded']);
    expect(new Set(audit.events.map(({ id }) => id)).size).toBe(2);
  });

  it('rejects malformed identities and oversized metadata at the port boundary', async () => {
    const audit = new CatalogoAdminAuditMemory();
    const valid = {
      requestId: '29bbfaac-4135-4618-8578-9c029e1a67da',
      actorUsuarioId: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.product.update',
      phase: 'requested',
      targetType: 'product',
      targetId: null,
      metadata: {},
    } as const;

    await expect(audit.append({ ...valid, actorUsuarioId: 'not-a-uuid' })).rejects.toThrow(/UUID/);
    await expect(
      audit.append({
        ...valid,
        metadata: { value: 'x'.repeat(4_096) },
      }),
    ).rejects.toThrow(/byte limit/);
    expect(audit.events).toEqual([]);
  });
});
