import { createRequire } from 'node:module';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { catalogoRouter } from '../../apps/eunenem-server/server/trpc/catalogo-router.js';
import { CatalogoRepositoryPostgres } from '../../src/adapters/catalogo/repository.postgres.js';
import { ObjectStorageMinio } from '../../src/adapters/storage/object-storage.minio.js';
import {
  makeCatalogoCategoria,
  makeCatalogoLista,
  makeCatalogoListaItem,
  makeCatalogoProduto,
} from '../helpers/catalogo-repository.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

// Resolve the HTTP adapter from the app dependency graph, as production does.
const appRequire = createRequire(
  new URL('../../apps/eunenem-server/package.json', import.meta.url),
);
const { fetchRequestHandler } = appRequire('@trpc/server/adapters/fetch') as {
  fetchRequestHandler: (options: Record<string, unknown>) => Promise<Response>;
};

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await testDb?.teardown();
});

it('serves both public queries with null for foreign-bucket/arbitrary images, retaining valid images and safe diagnostics', async () => {
  await testDb.db.deleteFrom('catalogo_lista_itens').execute();
  await testDb.db.deleteFrom('catalogo_listas').execute();
  await testDb.db.deleteFrom('catalogo_produtos').execute();
  await testDb.db.deleteFrom('catalogo_categorias').execute();
  const repo = new CatalogoRepositoryPostgres(testDb.db);
  const storage = new ObjectStorageMinio({
    endpoint: 'https://storage.example.com',
    bucket: 'staging',
    region: 'us-east-1',
    accessKeyId: 'synthetic',
    secretAccessKey: 'synthetic',
  });
  const category = makeCatalogoCategoria();
  await repo.createCategoria(category);
  const key = 'catalogo/produtos/10000000-0000-4000-8000-000000000001.png';
  const bad = makeCatalogoProduto(category.id, {
    imageUrl: `https://storage.example.com/prod/${key}`,
  });
  const good = makeCatalogoProduto(category.id, { imageUrl: storage.urlPublica(key) });
  await repo.createProduto(bad);
  await repo.createProduto(good);
  const list = makeCatalogoLista({
    imageUrl: 'https://untrusted.example/tracker.png?secret=never-log',
  });
  await repo.createLista(list);
  await repo.replaceListaItens(list.id, [
    makeCatalogoListaItem(list.id, bad.id),
    makeCatalogoListaItem(list.id, good.id, { position: 1 }),
  ]);
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const deps = {
    catalogoRepository: repo,
    objectStorage: storage,
    observability: { logger },
  } as unknown as ServerDeps;
  const query = (name: string) =>
    fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request(`http://localhost/trpc/${name}`),
      router: catalogoRouter,
      createContext: () => ({ deps, headers: new Headers(), resHeaders: new Headers() }),
    });
  const sections = await query('listSections');
  expect(sections.status).toBe(200);
  const sectionsBody = await sections.json();
  expect(sectionsBody.result.data[0].items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: bad.id, imageUrl: null }),
      expect.objectContaining({ id: good.id, imageUrl: storage.urlPublica(key) }),
    ]),
  );
  const lists = await query('listListasProntas');
  expect(lists.status).toBe(200);
  const listsBody = await lists.json();
  expect(listsBody.result.data[list.id]).toMatchObject({
    imageUrl: null,
    items: expect.arrayContaining([
      expect.objectContaining({ id: bad.id, imageUrl: null }),
      expect.objectContaining({ id: good.id, imageUrl: storage.urlPublica(key) }),
    ]),
  });
  expect(logger.warn).toHaveBeenCalledWith(
    'catalogo.image_rejected',
    expect.objectContaining({
      reason: 'image_url_policy',
      entityId: bad.id,
      entityType: 'produto',
    }),
  );
  expect(logger.warn).toHaveBeenCalledWith(
    'catalogo.image_rejected',
    expect.objectContaining({ reason: 'image_url_policy', entityId: list.id, entityType: 'lista' }),
  );
  const wireAndLogs = JSON.stringify([
    sectionsBody,
    listsBody,
    logger.warn.mock.calls,
    logger.error.mock.calls,
  ]);
  expect(wireAndLogs).not.toContain(bad.imageUrl);
  expect(wireAndLogs).not.toContain('untrusted.example');
  expect(wireAndLogs).not.toContain('never-log');
});

it('logs bounded SQLSTATE for a real PG failure without leaking the driver detail to logs or HTTP', async () => {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const deps = {
    catalogoRepository: new CatalogoRepositoryPostgres(
      testDb.db.withSchema('synthetic_missing_catalog'),
    ),
    observability: { logger },
  } as unknown as ServerDeps;
  for (const operation of ['listSections', 'listListasProntas']) {
    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request(`http://localhost/trpc/${operation}`),
      router: catalogoRouter,
      createContext: () => ({ deps, headers: new Headers(), resHeaders: new Headers() }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('synthetic_missing_catalog');
    expect(logger.error).toHaveBeenCalledWith('catalogo.query_failed', {
      operation,
      reason: 'database_error',
      sqlState: '42P01',
    });
  }
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('synthetic_missing_catalog');
});
