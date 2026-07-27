import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import {
  CatalogoImageUrlPublicaSchema,
  CatalogoItemPublicoSchema,
} from '../../../apps/eunenem-server/server/trpc/catalogo-router.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import type { CatalogoRepository } from '../../../src/adapters/catalogo/repository.js';
import { CatalogoRepositoryMemory } from '../../../src/adapters/catalogo/repository.memory.js';
import { ObjectStorageMemory } from '../../../src/adapters/storage/object-storage.memory.js';
import {
  makeCatalogoCategoria,
  makeCatalogoLista,
  makeCatalogoListaItem,
  makeCatalogoProduto,
} from '../../helpers/catalogo-repository.conformance.js';

function callerFor(catalogoRepository: CatalogoRepository) {
  const context: TrpcContext = {
    deps: {
      catalogoRepository,
      objectStorage: new ObjectStorageMemory('catalog-test'),
    } as ServerDeps,
    headers: new Headers(),
    resHeaders: new Headers(),
  };
  return appRouter.createCaller(context);
}

describe('catalogo public router', () => {
  it('rejects unknown input keys on both no-input public queries', async () => {
    const caller = callerFor(new CatalogoRepositoryMemory());

    await expect(caller.catalogo.listSections({ extra: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.catalogo.listListasProntas({ extra: true } as never)).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      },
    );
  });

  it('requires positive prices and one of the six seeded background tokens', () => {
    const validItem = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Produto',
      price: 1,
      suggestedQty: 1,
      emoji: '🍼',
      bgColor: 'var(--blue-soft)',
      category: 'categoria-aberta',
      imageUrl: null,
    };

    expect(CatalogoItemPublicoSchema.safeParse(validItem).success).toBe(true);
    expect(CatalogoItemPublicoSchema.safeParse({ ...validItem, price: 0 }).success).toBe(false);
    expect(CatalogoItemPublicoSchema.safeParse({ ...validItem, price: -1 }).success).toBe(false);
    expect(
      CatalogoItemPublicoSchema.safeParse({ ...validItem, bgColor: 'var(--arbitrary)' }).success,
    ).toBe(false);
  });

  it('keeps the static output schema structural; the runtime projection owns origin policy', () => {
    expect(CatalogoImageUrlPublicaSchema.safeParse('/products/item.png').success).toBe(true);
    expect(CatalogoImageUrlPublicaSchema.safeParse(null).success).toBe(true);
    expect(CatalogoImageUrlPublicaSchema.safeParse('').success).toBe(false);
    expect(CatalogoImageUrlPublicaSchema.safeParse('x'.repeat(2_049)).success).toBe(false);
  });

  it('listSections groups ordered active products with data-driven category fields', async () => {
    const repository = new CatalogoRepositoryMemory();
    const categoriaPrimeira = makeCatalogoCategoria({
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'categoria-criada-pelo-admin',
      label: 'Categoria criada pelo admin',
      position: 0,
    });
    const categoriaSegunda = makeCatalogoCategoria({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'outra-categoria-aberta',
      label: 'Outra categoria',
      position: 1,
    });
    const categoriaVazia = makeCatalogoCategoria({
      slug: 'sem-produtos',
      label: 'Sem produtos',
      position: 2,
    });
    await repository.createCategoria(categoriaSegunda);
    await repository.createCategoria(categoriaVazia);
    await repository.createCategoria(categoriaPrimeira);

    const produtoPrimeiro = makeCatalogoProduto(categoriaPrimeira.id, {
      id: '10000000-0000-4000-8000-000000000002',
      nome: 'Produto popular',
      precoCents: 1_250,
      quantidadeSugerida: 3,
      position: 1,
      imageUrl: '/products/popular.png',
      popularidade: 8,
    });
    const produtoInativo = makeCatalogoProduto(categoriaPrimeira.id, {
      id: '10000000-0000-4000-8000-000000000001',
      nome: 'Não deve aparecer',
      position: 0,
      ativo: false,
    });
    const produtoSemPopularidade = makeCatalogoProduto(categoriaSegunda.id, {
      id: '20000000-0000-4000-8000-000000000001',
      nome: 'Produto sem popularidade',
      precoCents: 1_999,
      quantidadeSugerida: 2,
      popularidade: null,
    });
    await repository.createProduto(produtoSemPopularidade);
    await repository.createProduto(produtoInativo);
    await repository.createProduto(produtoPrimeiro);

    const result = await callerFor(repository).catalogo.listSections();

    expect(result).toEqual([
      {
        category: 'categoria-criada-pelo-admin',
        label: 'Categoria criada pelo admin',
        items: [
          {
            id: produtoPrimeiro.id,
            name: 'Produto popular',
            price: 12.5,
            suggestedQty: 3,
            emoji: produtoPrimeiro.emoji,
            bgColor: produtoPrimeiro.bgColor,
            category: 'categoria-criada-pelo-admin',
            imageUrl: '/products/popular.png',
            popularity: 8,
          },
        ],
      },
      {
        category: 'outra-categoria-aberta',
        label: 'Outra categoria',
        items: [
          {
            id: produtoSemPopularidade.id,
            name: 'Produto sem popularidade',
            price: 19.99,
            suggestedQty: 2,
            emoji: produtoSemPopularidade.emoji,
            bgColor: produtoSemPopularidade.bgColor,
            category: 'outra-categoria-aberta',
            imageUrl: null,
          },
        ],
      },
    ]);
    expect(result[1]?.items[0]).not.toHaveProperty('popularity');
  });

  it('listListasProntas keeps active empty lists and uses persisted item quantities', async () => {
    const repository = new CatalogoRepositoryMemory();
    const categoria = makeCatalogoCategoria();
    await repository.createCategoria(categoria);

    const produtoAtivo = makeCatalogoProduto(categoria.id, {
      nome: 'Produto ativo',
      precoCents: 3_045,
      quantidadeSugerida: 99,
      imageUrl: '/products/ativo.jpg',
    });
    const produtoInativo = makeCatalogoProduto(categoria.id, {
      nome: 'Produto inativo',
      ativo: false,
    });
    await repository.createProduto(produtoAtivo);
    await repository.createProduto(produtoInativo);

    const listaVazia = makeCatalogoLista({
      nome: 'Lista vazia ativa',
      descricao: null,
      position: 0,
    });
    const listaPreenchida = makeCatalogoLista({
      slug: 'kit-personalizado',
      nome: 'Kit personalizado',
      descricao: 'Descrição do banco',
      imageUrl: '/listas-prontas/kit.png',
      position: 1,
    });
    const listaInativa = makeCatalogoLista({
      slug: 'lista-inativa',
      nome: 'Lista inativa',
      position: 2,
      ativo: false,
    });
    await repository.createLista(listaPreenchida);
    await repository.createLista(listaInativa);
    await repository.createLista(listaVazia);
    await repository.replaceListaItens(listaPreenchida.id, [
      makeCatalogoListaItem(listaPreenchida.id, produtoInativo.id, {
        quantidade: 11,
        position: 0,
      }),
      makeCatalogoListaItem(listaPreenchida.id, produtoAtivo.id, {
        quantidade: 7,
        position: 1,
      }),
    ]);

    const result = await callerFor(repository).catalogo.listListasProntas();

    expect(Object.keys(result)).toEqual([listaVazia.id, 'kit-personalizado']);
    expect(result).toEqual({
      [listaVazia.id]: {
        id: listaVazia.id,
        title: 'Lista vazia ativa',
        description: '',
        imageUrl: null,
        items: [],
      },
      'kit-personalizado': {
        id: 'kit-personalizado',
        title: 'Kit personalizado',
        description: 'Descrição do banco',
        imageUrl: '/listas-prontas/kit.png',
        items: [
          {
            id: produtoAtivo.id,
            name: 'Produto ativo',
            price: 30.45,
            suggestedQty: 7,
            emoji: produtoAtivo.emoji,
            bgColor: produtoAtivo.bgColor,
            imageUrl: '/products/ativo.jpg',
          },
        ],
      },
    });
  });

  it('surfaces repository failures generically instead of returning an empty projection', async () => {
    const failure = new Error('catalog database unavailable');
    const repository = {
      findProdutosAtivosComCategoria: vi.fn().mockRejectedValue(failure),
      findListasAtivasComItensAtivos: vi.fn().mockRejectedValue(failure),
    } as unknown as CatalogoRepository;
    const caller = callerFor(repository);

    await expect(caller.catalogo.listSections()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Não foi possível carregar o catálogo.',
    });
    await expect(caller.catalogo.listListasProntas()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Não foi possível carregar o catálogo.',
    });
  });

  it('fails loudly when a stored product or list image violates the read policy', async () => {
    const repository = new CatalogoRepositoryMemory();
    const categoria = makeCatalogoCategoria();
    await repository.createCategoria(categoria);
    await repository.createProduto(
      makeCatalogoProduto(categoria.id, {
        imageUrl: 'https://attacker.example/tracker.png',
      }),
    );

    await expect(callerFor(repository).catalogo.listSections()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Não foi possível carregar o catálogo.',
    });

    const cleanRepository = new CatalogoRepositoryMemory();
    await cleanRepository.createLista(
      makeCatalogoLista({
        imageUrl: 'https://127.0.0.1/private.png',
      }),
    );
    await expect(callerFor(cleanRepository).catalogo.listListasProntas()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Não foi possível carregar o catálogo.',
    });
  });
});
