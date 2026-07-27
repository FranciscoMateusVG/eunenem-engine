import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { CatalogoRepositoryMemory } from '../../../src/adapters/catalogo/repository.memory.js';
import { ObjectStorageMemory } from '../../../src/adapters/storage/object-storage.memory.js';
import { adminAuthOverrides } from '../../helpers/admin-auth.js';
import {
  makeCatalogoCategoria,
  makeCatalogoLista,
  makeCatalogoProduto,
} from '../../helpers/catalogo-repository.conformance.js';

type Caller = ReturnType<typeof appRouter.createCaller>;

const NOW = new Date('2026-07-27T15:30:00.000Z');

function buildRig(args: { allowAdmin?: boolean } = {}): {
  caller: Caller;
  repository: CatalogoRepositoryMemory;
  storage: ObjectStorageMemory;
} {
  const repository = new CatalogoRepositoryMemory();
  const storage = new ObjectStorageMemory('catalog-test');
  const auth = adminAuthOverrides();
  const deps = {
    catalogoRepository: repository,
    objectStorage: storage,
    clock: () => new Date(NOW),
    ...auth.depsOverrides,
    ...(args.allowAdmin === false ? { adminAllowedEmails: new Set<string>() } : {}),
  } as unknown as ServerDeps;
  const context: TrpcContext = {
    deps,
    headers: auth.headers,
    resHeaders: new Headers(),
  };
  return { caller: appRouter.createCaller(context), repository, storage };
}

describe('admin.catalog authorization', () => {
  it.each([
    ['listProducts', (caller: Caller) => caller.admin.catalog.listProducts({})],
    [
      'createProduct',
      (caller: Caller) =>
        caller.admin.catalog.createProduct({
          nome: 'Produto',
          precoCents: 100,
          emoji: '🎁',
          bgColor: 'var(--blue-soft)',
          idCategoria: randomUUID(),
        }),
    ],
    [
      'updateProduct',
      (caller: Caller) => caller.admin.catalog.updateProduct({ id: randomUUID(), nome: 'Produto' }),
    ],
    [
      'setProductAtivo',
      (caller: Caller) => caller.admin.catalog.setProductAtivo({ id: randomUUID(), ativo: false }),
    ],
    ['listCategories', (caller: Caller) => caller.admin.catalog.listCategories()],
    [
      'createCategory',
      (caller: Caller) =>
        caller.admin.catalog.createCategory({
          slug: 'nova-categoria',
          label: 'Nova categoria',
          position: 0,
        }),
    ],
    [
      'updateCategory',
      (caller: Caller) =>
        caller.admin.catalog.updateCategory({ id: randomUUID(), label: 'Categoria' }),
    ],
    [
      'deleteCategory',
      (caller: Caller) => caller.admin.catalog.deleteCategory({ id: randomUUID() }),
    ],
    ['listLists', (caller: Caller) => caller.admin.catalog.listLists({})],
    ['getList', (caller: Caller) => caller.admin.catalog.getList({ id: randomUUID() })],
    ['createList', (caller: Caller) => caller.admin.catalog.createList({ nome: 'Lista' })],
    [
      'updateList',
      (caller: Caller) => caller.admin.catalog.updateList({ id: randomUUID(), nome: 'Lista' }),
    ],
    [
      'setListAtivo',
      (caller: Caller) => caller.admin.catalog.setListAtivo({ id: randomUUID(), ativo: false }),
    ],
    [
      'setListItems',
      (caller: Caller) => caller.admin.catalog.setListItems({ idLista: randomUUID(), items: [] }),
    ],
    [
      'emitirUrlUploadImagemProduto',
      (caller: Caller) =>
        caller.admin.catalog.emitirUrlUploadImagemProduto({
          contentType: 'image/png',
        }),
    ],
  ])('%s rejects a valid non-allowlisted caller with FORBIDDEN', async (_name, invoke) => {
    const { caller } = buildRig({ allowAdmin: false });
    await expect(invoke(caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('admin.catalog strict inputs', () => {
  it.each([
    [
      'listProducts',
      (caller: Caller) => caller.admin.catalog.listProducts({ extra: true } as never),
    ],
    [
      'createProduct',
      (caller: Caller) =>
        caller.admin.catalog.createProduct({
          nome: 'Produto',
          precoCents: 100,
          emoji: '🎁',
          bgColor: 'var(--blue-soft)',
          idCategoria: randomUUID(),
          extra: true,
        } as never),
    ],
    [
      'updateProduct',
      (caller: Caller) =>
        caller.admin.catalog.updateProduct({
          id: randomUUID(),
          nome: 'Produto',
          extra: true,
        } as never),
    ],
    [
      'setProductAtivo',
      (caller: Caller) =>
        caller.admin.catalog.setProductAtivo({
          id: randomUUID(),
          ativo: true,
          extra: true,
        } as never),
    ],
    [
      'listCategories',
      (caller: Caller) => caller.admin.catalog.listCategories({ extra: true } as never),
    ],
    [
      'createCategory',
      (caller: Caller) =>
        caller.admin.catalog.createCategory({
          slug: 'categoria',
          label: 'Categoria',
          position: 0,
          extra: true,
        } as never),
    ],
    [
      'updateCategory',
      (caller: Caller) =>
        caller.admin.catalog.updateCategory({
          id: randomUUID(),
          label: 'Categoria',
          extra: true,
        } as never),
    ],
    [
      'deleteCategory',
      (caller: Caller) =>
        caller.admin.catalog.deleteCategory({ id: randomUUID(), extra: true } as never),
    ],
    ['listLists', (caller: Caller) => caller.admin.catalog.listLists({ extra: true } as never)],
    [
      'getList',
      (caller: Caller) => caller.admin.catalog.getList({ id: randomUUID(), extra: true } as never),
    ],
    [
      'createList',
      (caller: Caller) => caller.admin.catalog.createList({ nome: 'Lista', extra: true } as never),
    ],
    [
      'updateList',
      (caller: Caller) =>
        caller.admin.catalog.updateList({
          id: randomUUID(),
          nome: 'Lista',
          extra: true,
        } as never),
    ],
    [
      'setListAtivo',
      (caller: Caller) =>
        caller.admin.catalog.setListAtivo({
          id: randomUUID(),
          ativo: true,
          extra: true,
        } as never),
    ],
    [
      'setListItems outer',
      (caller: Caller) =>
        caller.admin.catalog.setListItems({
          idLista: randomUUID(),
          items: [],
          extra: true,
        } as never),
    ],
    [
      'setListItems nested',
      (caller: Caller) =>
        caller.admin.catalog.setListItems({
          idLista: randomUUID(),
          items: [
            {
              idProduto: randomUUID(),
              quantidade: 1,
              position: 0,
              extra: true,
            },
          ],
        } as never),
    ],
    [
      'emitirUrlUploadImagemProduto',
      (caller: Caller) =>
        caller.admin.catalog.emitirUrlUploadImagemProduto({
          contentType: 'image/png',
          extra: true,
        } as never),
    ],
  ])('%s rejects unknown keys with BAD_REQUEST', async (_name, invoke) => {
    const { caller } = buildRig();
    await expect(invoke(caller)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('admin.catalog products', () => {
  it('creates, lists, patches and toggles complete product DTOs with server-owned positions', async () => {
    const { caller, repository } = buildRig();
    const sourceCategory = makeCatalogoCategoria({ position: 0 });
    const targetCategory = makeCatalogoCategoria({ position: 1 });
    await repository.createCategoria(sourceCategory);
    await repository.createCategoria(targetCategory);
    await repository.createProduto(
      makeCatalogoProduto(targetCategory.id, { position: 4, nome: 'Existing target item' }),
    );

    const created = await caller.admin.catalog.createProduct({
      nome: '  Fralda RN  ',
      precoCents: 2_990,
      emoji: '🧷',
      bgColor: 'var(--pink-soft)',
      idCategoria: sourceCategory.id,
      imageUrl: '/products/fralda.png',
      popularidade: 10,
    });

    expect(created).toEqual({
      id: expect.any(String),
      idLegado: null,
      nome: 'Fralda RN',
      precoCents: 2_990,
      quantidadeSugerida: 1,
      emoji: '🧷',
      bgColor: 'var(--pink-soft)',
      idCategoria: sourceCategory.id,
      position: 0,
      imageUrl: '/products/fralda.png',
      popularidade: 10,
      ativo: true,
      criadoEm: NOW.toISOString(),
      atualizadoEm: NOW.toISOString(),
    });
    expect(Object.keys(created).sort()).toEqual(
      [
        'ativo',
        'atualizadoEm',
        'bgColor',
        'criadoEm',
        'emoji',
        'id',
        'idCategoria',
        'idLegado',
        'imageUrl',
        'nome',
        'popularidade',
        'position',
        'precoCents',
        'quantidadeSugerida',
      ].sort(),
    );

    const page = await caller.admin.catalog.listProducts({
      search: 'fralda',
      idCategoria: sourceCategory.id,
    });
    expect(page).toEqual({ products: [created], total: 1 });
    expect(page.products[0]).not.toHaveProperty('categoria');

    const moved = await caller.admin.catalog.updateProduct({
      id: created.id,
      idCategoria: targetCategory.id,
      nome: 'Fralda atualizada',
      imageUrl: null,
      popularidade: null,
    });
    expect(moved).toMatchObject({
      id: created.id,
      nome: 'Fralda atualizada',
      idCategoria: targetCategory.id,
      position: 5,
      imageUrl: null,
      popularidade: null,
      criadoEm: NOW.toISOString(),
      atualizadoEm: NOW.toISOString(),
    });

    const disabled = await caller.admin.catalog.setProductAtivo({
      id: created.id,
      ativo: false,
    });
    expect(disabled.ativo).toBe(false);
    await expect(
      caller.admin.catalog.listProducts({ idCategoria: sourceCategory.id }),
    ).resolves.toEqual({
      products: [],
      total: 0,
    });
    await expect(
      caller.admin.catalog.listProducts({ includeInactive: true }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it('maps missing products/categories to NOT_FOUND and validates image URLs', async () => {
    const { caller, repository } = buildRig();
    const category = makeCatalogoCategoria();
    await repository.createCategoria(category);

    await expect(
      caller.admin.catalog.createProduct({
        nome: 'Sem categoria',
        precoCents: 100,
        emoji: '🎁',
        bgColor: 'var(--blue-soft)',
        idCategoria: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.admin.catalog.updateProduct({ id: randomUUID(), nome: 'Ausente' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const existing = makeCatalogoProduto(category.id);
    await repository.createProduto(existing);
    await expect(
      caller.admin.catalog.updateProduct({
        id: existing.id,
        idCategoria: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.admin.catalog.setProductAtivo({ id: randomUUID(), ativo: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    for (const imageUrl of [
      '//cdn.example.com/x.png',
      'http://example.com/x.png',
      'http://minio:9000/x.png',
      'data:image/png;base64,AA',
      'javascript:alert(1)',
      'https://user:pass@example.com/x.png',
      'products/x.png',
      '/\\evil.example/x.png',
    ]) {
      await expect(
        caller.admin.catalog.createProduct({
          nome: 'Imagem inválida',
          precoCents: 100,
          emoji: '🎁',
          bgColor: 'var(--blue-soft)',
          idCategoria: category.id,
          imageUrl,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.admin.catalog.updateProduct({
          id: existing.id,
          imageUrl,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(
      caller.admin.catalog.updateProduct({
        id: existing.id,
        imageUrl: 'http://127.0.0.1:9000/catalog/product.png',
      }),
    ).resolves.toMatchObject({
      imageUrl: 'http://127.0.0.1:9000/catalog/product.png',
    });
  });

  it('rejects empty patches, oversized names and non-seeded bgColor tokens', async () => {
    const { caller, repository } = buildRig();
    const category = makeCatalogoCategoria();
    const product = makeCatalogoProduto(category.id);
    await repository.createCategoria(category);
    await repository.createProduto(product);

    await expect(caller.admin.catalog.updateProduct({ id: product.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.admin.catalog.createProduct({
        nome: 'x'.repeat(201),
        precoCents: 100,
        emoji: '🎁',
        bgColor: 'var(--blue-soft)',
        idCategoria: category.id,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.updateProduct({
        id: product.id,
        bgColor: '#fff' as 'var(--blue-soft)',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.updateProduct({
        id: product.id,
        emoji: 'x'.repeat(32),
      }),
    ).resolves.toMatchObject({ emoji: 'x'.repeat(32) });
    await expect(
      caller.admin.catalog.updateProduct({
        id: product.id,
        emoji: 'x'.repeat(33),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.admin.catalog.listProducts({ page: 100_001 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('admin.catalog categories', () => {
  it('creates, counts, updates and deletes empty categories', async () => {
    const { caller, repository } = buildRig();
    const created = await caller.admin.catalog.createCategory({
      slug: 'cuidados-diarios',
      label: '  Cuidados diários  ',
      position: 3,
    });
    expect(created).toEqual({
      id: expect.any(String),
      slug: 'cuidados-diarios',
      label: 'Cuidados diários',
      position: 3,
      quantidadeProdutos: 0,
      criadoEm: NOW.toISOString(),
    });

    await repository.createProduto(
      makeCatalogoProduto(created.id, { ativo: false, nome: 'Produto inativo' }),
    );
    const listed = await caller.admin.catalog.listCategories();
    expect(listed).toEqual([{ ...created, quantidadeProdutos: 1 }]);

    const updated = await caller.admin.catalog.updateCategory({
      id: created.id,
      label: 'Novo label',
      position: 8,
    });
    expect(updated).toEqual({ ...listed[0], label: 'Novo label', position: 8 });
    await expect(caller.admin.catalog.deleteCategory({ id: created.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const empty = await caller.admin.catalog.createCategory({
      slug: 'categoria-vazia',
      label: 'Vazia',
      position: 9,
    });
    await expect(caller.admin.catalog.deleteCategory({ id: empty.id })).resolves.toEqual({
      deleted: true,
    });
  });

  it('maps duplicate slugs to CONFLICT and validates reserved/kebab slugs', async () => {
    const { caller } = buildRig();
    const input = { slug: 'higiene-bebe', label: 'Higiene', position: 0 };
    await caller.admin.catalog.createCategory(input);
    await expect(caller.admin.catalog.createCategory(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    for (const slug of ['personalizado', 'Uppercase', 'com espaço', '-inicio', 'fim-']) {
      await expect(
        caller.admin.catalog.createCategory({ slug, label: 'Inválida', position: 0 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(
      caller.admin.catalog.updateCategory({ id: randomUUID(), label: 'Ausente' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller.admin.catalog.deleteCategory({ id: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects empty category patches and bounded slug/label overflow', async () => {
    const { caller, repository } = buildRig();
    const category = makeCatalogoCategoria();
    await repository.createCategoria(category);

    await expect(caller.admin.catalog.updateCategory({ id: category.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.admin.catalog.createCategory({
        slug: 'a'.repeat(81),
        label: 'Label',
        position: 0,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.createCategory({
        slug: 'label-grande',
        label: 'x'.repeat(121),
        position: 0,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.createCategory({
        slug: 'position-overflow',
        label: 'Position overflow',
        position: 2_147_483_648,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('admin.catalog lists', () => {
  it('creates at the next server position, patches nullable fields and toggles visibility', async () => {
    const { caller, repository } = buildRig();
    await repository.createLista(makeCatalogoLista({ position: 4, ativo: true }));

    const created = await caller.admin.catalog.createList({
      nome: '  Lista nova  ',
      descricao: 'Descrição',
      imageUrl: 'https://cdn.example.com/lista.png',
    });
    expect(created).toEqual({
      id: expect.any(String),
      slug: null,
      nome: 'Lista nova',
      descricao: 'Descrição',
      imageUrl: 'https://cdn.example.com/lista.png',
      position: 5,
      ativo: true,
      quantidadeItens: 0,
      criadoEm: NOW.toISOString(),
      atualizadoEm: NOW.toISOString(),
    });

    const renamed = await caller.admin.catalog.updateList({
      id: created.id,
      nome: 'Renomeada',
    });
    expect(renamed).toMatchObject({
      descricao: 'Descrição',
      imageUrl: 'https://cdn.example.com/lista.png',
    });
    const cleared = await caller.admin.catalog.updateList({
      id: created.id,
      descricao: null,
      imageUrl: null,
    });
    expect(cleared).toMatchObject({ descricao: null, imageUrl: null });

    const disabled = await caller.admin.catalog.setListAtivo({
      id: created.id,
      ativo: false,
    });
    expect(disabled.ativo).toBe(false);
    const activeOnly = await caller.admin.catalog.listLists({});
    expect(activeOnly).toHaveLength(1);
    const all = await caller.admin.catalog.listLists({ includeInactive: true });
    expect(all).toHaveLength(2);
  });

  it('maps missing list mutations to NOT_FOUND', async () => {
    const { caller } = buildRig();
    await expect(
      caller.admin.catalog.updateList({ id: randomUUID(), nome: 'Ausente' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.admin.catalog.setListAtivo({ id: randomUUID(), ativo: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller.admin.catalog.getList({ id: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects empty list patches and bounded name/description overflow', async () => {
    const { caller, repository } = buildRig();
    const list = makeCatalogoLista();
    await repository.createLista(list);

    await expect(caller.admin.catalog.updateList({ id: list.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.admin.catalog.createList({ nome: 'x'.repeat(201) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.admin.catalog.updateList({
        id: list.id,
        descricao: 'x'.repeat(2_001),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.updateList({
        id: list.id,
        descricao: '  descrição aparada  ',
      }),
    ).resolves.toMatchObject({ descricao: 'descrição aparada' });
  });
});

describe('admin.catalog setListItems and upload presign', () => {
  it('replaces and clears a full item set with generated UUIDs', async () => {
    const { caller, repository } = buildRig();
    const category = makeCatalogoCategoria();
    const productA = makeCatalogoProduto(category.id);
    const productB = makeCatalogoProduto(category.id);
    const list = makeCatalogoLista();
    await repository.createCategoria(category);
    await repository.createProduto(productA);
    await repository.createProduto(productB);
    await repository.createLista(list);

    await expect(
      caller.admin.catalog.setListItems({
        idLista: list.id,
        items: [
          { idProduto: productA.id, quantidade: 2, position: 0 },
          { idProduto: productB.id, quantidade: 3, position: 1 },
        ],
      }),
    ).resolves.toEqual({ updated: true });
    const persisted = await repository.findListaByIdComItens(list.id);
    expect(persisted?.itens).toHaveLength(2);
    expect(persisted?.itens.map(({ item }) => item.id)).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    await expect(caller.admin.catalog.getList({ id: list.id })).resolves.toEqual({
      id: list.id,
      slug: list.slug,
      nome: list.nome,
      descricao: list.descricao,
      imageUrl: list.imageUrl,
      position: list.position,
      ativo: list.ativo,
      quantidadeItens: 2,
      criadoEm: list.criadoEm.toISOString(),
      atualizadoEm: list.atualizadoEm.toISOString(),
      items: [
        { idProduto: productA.id, quantidade: 2, position: 0 },
        { idProduto: productB.id, quantidade: 3, position: 1 },
      ],
    });
    await expect(
      caller.admin.catalog.setListItems({ idLista: list.id, items: [] }),
    ).resolves.toEqual({ updated: true });
    expect((await repository.findListaByIdComItens(list.id))?.itens).toEqual([]);
  });

  it('prevalidates duplicate products/positions and maps missing references to NOT_FOUND', async () => {
    const { caller, repository } = buildRig();
    const category = makeCatalogoCategoria();
    const productA = makeCatalogoProduto(category.id);
    const productB = makeCatalogoProduto(category.id);
    const list = makeCatalogoLista();
    await repository.createCategoria(category);
    await repository.createProduto(productA);
    await repository.createProduto(productB);
    await repository.createLista(list);

    await expect(
      caller.admin.catalog.setListItems({
        idLista: list.id,
        items: [
          { idProduto: productA.id, quantidade: 1, position: 0 },
          { idProduto: productA.id, quantidade: 2, position: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.setListItems({
        idLista: list.id,
        items: [
          { idProduto: productA.id, quantidade: 1, position: 0 },
          { idProduto: productB.id, quantidade: 2, position: 0 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.catalog.setListItems({ idLista: randomUUID(), items: [] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.admin.catalog.setListItems({
        idLista: list.id,
        items: [{ idProduto: randomUUID(), quantidade: 1, position: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.admin.catalog.setListItems({
        idLista: list.id,
        items: Array.from({ length: 1_001 }, (_, position) => ({
          idProduto: randomUUID(),
          quantidade: 1,
          position,
        })),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('presigns only the exact image MIME enum through the catalogue storage method', async () => {
    const { caller, repository, storage } = buildRig();
    const result = await caller.admin.catalog.emitirUrlUploadImagemProduto({
      contentType: 'image/webp',
    });
    expect(result.objectKey).toMatch(/^catalogo\/produtos\/[0-9a-f-]{36}\.webp$/);
    expect(result.uploadUrl).toContain(result.objectKey);
    expect(result.publicUrl).toContain(result.objectKey);
    expect(storage.catalogoUploads).toHaveLength(1);
    expect(storage.catalogoUploads[0]?.input).toEqual({ contentType: 'image/webp' });

    const category = makeCatalogoCategoria();
    await repository.createCategoria(category);
    await expect(
      caller.admin.catalog.createProduct({
        nome: 'Produto com upload',
        precoCents: 100,
        emoji: '🎁',
        bgColor: 'var(--blue-soft)',
        idCategoria: category.id,
        imageUrl: result.publicUrl,
      }),
    ).resolves.toMatchObject({ imageUrl: result.publicUrl });

    await expect(
      caller.admin.catalog.emitirUrlUploadImagemProduto({
        contentType: 'image/gif' as 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
