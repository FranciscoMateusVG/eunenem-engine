import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CatalogoRepositoryMemory } from '../../src/adapters/catalogo/repository.memory.js';
import { CatalogoAdminAuditMemory } from '../../src/adapters/catalogo-admin-audit/catalogo-admin-audit.memory.js';
import { ObjectStorageMemory } from '../../src/adapters/storage/object-storage.memory.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const RATE_LIMIT_KEY_PREFIX = 'trpc:admin.catalog.presign:user:';
const START = new Date('2026-07-27T18:00:00.000Z');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

beforeEach(async () => {
  await testDb.db
    .deleteFrom('rate_limit')
    .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
    .execute();
});

afterEach(async () => {
  await testDb.db
    .deleteFrom('rate_limit')
    .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
    .execute();
});

function buildCaller(args: { email: string; now: () => Date; storage: ObjectStorageMemory }) {
  const auth = adminAuthOverrides(args.email);
  const audit = new CatalogoAdminAuditMemory(args.now);
  const deps = {
    db: testDb.db,
    catalogoAdminAudit: audit,
    catalogoRepository: new CatalogoRepositoryMemory(),
    objectStorage: args.storage,
    clock: args.now,
    ...auth.depsOverrides,
  } as unknown as ServerDeps;
  const context: TrpcContext = {
    deps,
    headers: auth.headers,
    resHeaders: new Headers(),
  };
  return { audit, caller: appRouter.createCaller(context) };
}

describe('admin.catalog.emitirUrlUploadImagemProduto durable rate limit', () => {
  it('allows ten, rejects the eleventh before storage, isolates admins, and resets after the window', async () => {
    let now = new Date(START);
    const clock = () => new Date(now);
    const primaryStorage = new ObjectStorageMemory('catalog-rate-limit-primary');
    const secondaryStorage = new ObjectStorageMemory('catalog-rate-limit-secondary');
    const { audit: primaryAudit, caller: primary } = buildCaller({
      email: 'catalog-rate-limit-primary@example.com',
      now: clock,
      storage: primaryStorage,
    });
    const { caller: secondary } = buildCaller({
      email: 'catalog-rate-limit-secondary@example.com',
      now: clock,
      storage: secondaryStorage,
    });
    const input = { contentType: 'image/png' as const, sizeBytes: 1_024 };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        primary.admin.catalog.emitirUrlUploadImagemProduto(input),
      ).resolves.toMatchObject({
        objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
      });
    }
    expect(primaryStorage.catalogoUploads).toHaveLength(10);

    await expect(primary.admin.catalog.emitirUrlUploadImagemProduto(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(primaryStorage.catalogoUploads).toHaveLength(10);
    expect(primaryAudit.events.slice(-2).map(({ phase }) => phase)).toEqual([
      'requested',
      'failed',
    ]);
    expect(primaryAudit.events.at(-1)?.metadata).toMatchObject({
      failureCode: 'TOO_MANY_REQUESTS',
    });

    await expect(
      secondary.admin.catalog.emitirUrlUploadImagemProduto(input),
    ).resolves.toMatchObject({
      objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
    });
    expect(secondaryStorage.catalogoUploads).toHaveLength(1);

    const exhaustedRows = await testDb.db
      .selectFrom('rate_limit')
      .select(['key', 'count'])
      .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
      .execute();
    expect(exhaustedRows).toHaveLength(2);
    expect(exhaustedRows.map((row) => row.count).sort((a, b) => a - b)).toEqual([1, 11]);

    now = new Date(START.getTime() + 60_001);
    await expect(primary.admin.catalog.emitirUrlUploadImagemProduto(input)).resolves.toMatchObject({
      objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
    });
    expect(primaryStorage.catalogoUploads).toHaveLength(11);

    const resetRows = await testDb.db
      .selectFrom('rate_limit')
      .select('count')
      .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
      .execute();
    expect(resetRows.map((row) => row.count).sort((a, b) => a - b)).toEqual([1, 1]);
  });

  it('uses the original window start under sustained cadence and resets at the exact boundary', async () => {
    let now = new Date(START);
    const clock = () => new Date(now);
    const storage = new ObjectStorageMemory('catalog-rate-limit-cadence');
    const { caller } = buildCaller({
      email: 'catalog-rate-limit-cadence@example.com',
      now: clock,
      storage,
    });
    const input = { contentType: 'image/png' as const, sizeBytes: 1_024 };

    // Ten requests spaced ten seconds apart cross the first window boundary.
    // The boundary request at t=60s starts a new window; later requests must
    // not keep moving that window start forward.
    for (let seconds = 0; seconds <= 90; seconds += 10) {
      now = new Date(START.getTime() + seconds * 1_000);
      await expect(caller.admin.catalog.emitirUrlUploadImagemProduto(input)).resolves.toMatchObject(
        {
          objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
        },
      );
    }

    now = new Date(START.getTime() + 100_000);
    await expect(caller.admin.catalog.emitirUrlUploadImagemProduto(input)).resolves.toMatchObject({
      objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
    });
    expect(storage.catalogoUploads).toHaveLength(11);

    const row = await testDb.db
      .selectFrom('rate_limit')
      .select(['count', 'last_request'])
      .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
      .executeTakeFirstOrThrow();
    expect(row.count).toBe(5);
    expect(Number(row.last_request)).toBe(START.getTime() + 60_000);
  });

  it('does not let denied retries extend lockout beyond the original window boundary', async () => {
    let now = new Date(START);
    const clock = () => new Date(now);
    const storage = new ObjectStorageMemory('catalog-rate-limit-denied-retry');
    const { caller } = buildCaller({
      email: 'catalog-rate-limit-denied-retry@example.com',
      now: clock,
      storage,
    });
    const input = { contentType: 'image/png' as const, sizeBytes: 1_024 };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(caller.admin.catalog.emitirUrlUploadImagemProduto(input)).resolves.toMatchObject(
        {
          objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
        },
      );
    }

    now = new Date(START.getTime() + 10_000);
    await expect(caller.admin.catalog.emitirUrlUploadImagemProduto(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    now = new Date(START.getTime() + 59_999);
    await expect(caller.admin.catalog.emitirUrlUploadImagemProduto(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(storage.catalogoUploads).toHaveLength(10);

    const deniedRow = await testDb.db
      .selectFrom('rate_limit')
      .select(['count', 'last_request'])
      .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
      .executeTakeFirstOrThrow();
    expect(deniedRow.count).toBe(12);
    expect(Number(deniedRow.last_request)).toBe(START.getTime());

    // Boundary is inclusive: elapsed >= windowMs starts a fresh window.
    now = new Date(START.getTime() + 60_000);
    await expect(caller.admin.catalog.emitirUrlUploadImagemProduto(input)).resolves.toMatchObject({
      objectKey: expect.stringMatching(/^catalogo\/produtos\/.+\.png$/),
    });
    expect(storage.catalogoUploads).toHaveLength(11);

    const resetRow = await testDb.db
      .selectFrom('rate_limit')
      .select(['count', 'last_request'])
      .where('key', 'like', `${RATE_LIMIT_KEY_PREFIX}%`)
      .executeTakeFirstOrThrow();
    expect(resetRow.count).toBe(1);
    expect(Number(resetRow.last_request)).toBe(START.getTime() + 60_000);
  });
});
