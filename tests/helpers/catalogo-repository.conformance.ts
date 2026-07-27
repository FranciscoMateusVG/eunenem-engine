import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CatalogoCategoria,
  CatalogoLista,
  CatalogoListaItem,
  CatalogoProduto,
  CatalogoRepository,
} from '../../src/adapters/catalogo/repository.js';
import { CatalogoConflictError } from '../../src/adapters/catalogo/repository.js';

const CREATED_AT = new Date('2026-07-27T12:00:00.000Z');
const UPDATED_AT = new Date('2026-07-27T13:00:00.000Z');

export function makeCatalogoCategoria(
  overrides: Partial<CatalogoCategoria> = {},
): CatalogoCategoria {
  return {
    id: randomUUID(),
    slug: `categoria-${randomUUID()}`,
    label: 'Categoria',
    position: 0,
    criadoEm: CREATED_AT,
    ...overrides,
  };
}

export function makeCatalogoProduto(
  idCategoria: string,
  overrides: Partial<CatalogoProduto> = {},
): CatalogoProduto {
  return {
    id: randomUUID(),
    idLegado: null,
    nome: 'Produto',
    precoCents: 1_999,
    quantidadeSugerida: 1,
    emoji: '🍼',
    bgColor: 'var(--blue-soft)',
    idCategoria,
    position: 0,
    imageUrl: null,
    popularidade: null,
    ativo: true,
    criadoEm: CREATED_AT,
    atualizadoEm: CREATED_AT,
    ...overrides,
  };
}

export function makeCatalogoLista(overrides: Partial<CatalogoLista> = {}): CatalogoLista {
  return {
    id: randomUUID(),
    slug: null,
    nome: 'Lista',
    descricao: null,
    imageUrl: null,
    position: 0,
    ativo: true,
    criadoEm: CREATED_AT,
    atualizadoEm: CREATED_AT,
    ...overrides,
  };
}

export function makeCatalogoListaItem(
  idLista: string,
  idProduto: string,
  overrides: Partial<CatalogoListaItem> = {},
): CatalogoListaItem {
  return {
    id: randomUUID(),
    idLista,
    idProduto,
    quantidade: 1,
    position: 0,
    ...overrides,
  };
}

interface CatalogoRepositoryConformanceOptions {
  readonly factory: () => CatalogoRepository | Promise<CatalogoRepository>;
  readonly resetState?: () => Promise<void>;
  readonly getSpans: () => ReadableSpan[];
  readonly resetSpans: () => void;
  readonly expectedDbSystem: string;
}

export function describeCatalogoRepositoryConformance(
  name: string,
  options: CatalogoRepositoryConformanceOptions,
): void {
  describe(`CatalogoRepository conformance — ${name}`, () => {
    let repo: CatalogoRepository;

    beforeEach(async () => {
      if (options.resetState) await options.resetState();
      options.resetSpans();
      repo = await options.factory();
    });

    it('creates, updates and finds a category without changing caller-owned timestamps', async () => {
      const original = makeCatalogoCategoria({ slug: 'roupa', label: 'Roupinhas' });
      await repo.createCategoria(original);
      expect(await repo.findCategoriaById(original.id)).toEqual(original);

      const updated: CatalogoCategoria = {
        ...original,
        label: 'Roupas',
        position: 7,
      };
      expect(await repo.updateCategoria(updated)).toBe(true);
      expect(await repo.findCategoriaById(original.id)).toEqual(updated);
      expect(await repo.updateCategoria(makeCatalogoCategoria())).toBe(false);
    });

    it('maps a duplicate category slug to the stable typed conflict', async () => {
      const original = makeCatalogoCategoria({ slug: 'slug-unico' });
      await repo.createCategoria(original);

      await expect(
        repo.createCategoria(makeCatalogoCategoria({ slug: original.slug })),
      ).rejects.toBeInstanceOf(CatalogoConflictError);
    });

    it('returns category counts including inactive products in category order', async () => {
      const first = makeCatalogoCategoria({ position: 0, slug: 'primeira' });
      const second = makeCatalogoCategoria({ position: 1, slug: 'segunda' });
      await repo.createCategoria(second);
      await repo.createCategoria(first);
      await repo.createProduto(makeCatalogoProduto(first.id, { position: 0 }));
      await repo.createProduto(makeCatalogoProduto(first.id, { position: 1, ativo: false }));

      expect(await repo.findCategoriasComContagem()).toEqual([
        { categoria: first, quantidadeProdutos: 2 },
        { categoria: second, quantidadeProdutos: 0 },
      ]);
    });

    it('allows tied category positions with UUID ordering and rejects negative positions', async () => {
      const later = makeCatalogoCategoria({
        id: '00000000-0000-4000-8000-000000000002',
        position: 0,
      });
      const earlier = makeCatalogoCategoria({
        id: '00000000-0000-4000-8000-000000000001',
        position: 0,
      });
      await repo.createCategoria(later);
      await repo.createCategoria(earlier);
      expect((await repo.findCategoriasComContagem()).map(({ categoria }) => categoria.id)).toEqual(
        [earlier.id, later.id],
      );
      await expect(repo.createCategoria(makeCatalogoCategoria({ position: -1 }))).rejects.toThrow();
    });

    it('deletes only an existing empty category and treats inactive products as non-empty', async () => {
      const empty = makeCatalogoCategoria({ position: 0 });
      const occupied = makeCatalogoCategoria({ position: 1 });
      await repo.createCategoria(empty);
      await repo.createCategoria(occupied);
      await repo.createProduto(makeCatalogoProduto(occupied.id, { position: 0, ativo: false }));

      expect(await repo.deleteCategoriaVazia(randomUUID())).toBe('not_found');
      expect(await repo.deleteCategoriaVazia(occupied.id)).toBe('not_empty');
      expect(await repo.deleteCategoriaVazia(empty.id)).toBe('deleted');
      expect(await repo.findCategoriaById(empty.id)).toBeUndefined();
    });

    it('creates, updates and finds a complete product record', async () => {
      const category = makeCatalogoCategoria();
      await repo.createCategoria(category);
      const original = makeCatalogoProduto(category.id, {
        idLegado: 'legacy-1',
        nome: 'Carrinho',
      });
      await repo.createProduto(original);
      expect(await repo.findProdutoById(original.id)).toEqual(original);

      const updated: CatalogoProduto = {
        ...original,
        nome: 'Carrinho atualizado',
        ativo: false,
        atualizadoEm: UPDATED_AT,
      };
      expect(await repo.updateProduto(updated)).toBe(true);
      expect(await repo.findProdutoById(original.id)).toEqual(updated);
      expect(await repo.updateProduto(makeCatalogoProduto(category.id))).toBe(false);
      await expect(
        repo.createProduto(makeCatalogoProduto(category.id, { position: -1 })),
      ).rejects.toThrow();
    });

    it('allocates the next product position from all rows in the target category', async () => {
      const firstCategory = makeCatalogoCategoria({ position: 0 });
      const secondCategory = makeCatalogoCategoria({ position: 1 });
      await repo.createCategoria(firstCategory);
      await repo.createCategoria(secondCategory);
      expect(await repo.findNextProdutoPosition(firstCategory.id)).toBe(0);
      await repo.createProduto(
        makeCatalogoProduto(firstCategory.id, { position: 4, ativo: false }),
      );
      await repo.createProduto(makeCatalogoProduto(firstCategory.id, { position: 1 }));
      await repo.createProduto(makeCatalogoProduto(secondCategory.id, { position: 9 }));
      expect(await repo.findNextProdutoPosition(firstCategory.id)).toBe(5);
      expect(await repo.findNextProdutoPosition(secondCategory.id)).toBe(10);
    });

    it('filters before paginating, treats search metacharacters literally and returns exact total', async () => {
      const firstCategory = makeCatalogoCategoria({ slug: 'a', position: 0 });
      const secondCategory = makeCatalogoCategoria({ slug: 'b', position: 1 });
      await repo.createCategoria(firstCategory);
      await repo.createCategoria(secondCategory);

      const first = makeCatalogoProduto(firstCategory.id, {
        nome: 'Body 100% algodão',
        position: 0,
      });
      const second = makeCatalogoProduto(firstCategory.id, {
        nome: 'Body _ especial',
        position: 1,
      });
      const inactive = makeCatalogoProduto(firstCategory.id, {
        nome: 'Body inativo',
        position: 2,
        ativo: false,
      });
      const otherCategory = makeCatalogoProduto(secondCategory.id, {
        nome: 'Body passeio',
        position: 0,
      });
      for (const product of [otherCategory, inactive, second, first]) {
        await repo.createProduto(product);
      }

      const activePage = await repo.findProdutosPage({
        includeInactive: false,
        idCategoria: firstCategory.id,
        search: ' BODY ',
        offset: 1,
        limit: 1,
      });
      expect(activePage.total).toBe(2);
      expect(activePage.items.map(({ produto }) => produto.id)).toEqual([second.id]);

      const literalPercent = await repo.findProdutosPage({
        includeInactive: true,
        search: '%',
        offset: 0,
        limit: 10,
      });
      expect(literalPercent.items.map(({ produto }) => produto.id)).toEqual([first.id]);

      const literalUnderscore = await repo.findProdutosPage({
        includeInactive: true,
        search: '_',
        offset: 0,
        limit: 10,
      });
      expect(literalUnderscore.items.map(({ produto }) => produto.id)).toEqual([second.id]);
    });

    it('returns the public product projection in category/product position order and omits inactive products', async () => {
      const firstCategory = makeCatalogoCategoria({ position: 0 });
      const secondCategory = makeCatalogoCategoria({ position: 1 });
      await repo.createCategoria(firstCategory);
      await repo.createCategoria(secondCategory);

      const first = makeCatalogoProduto(firstCategory.id, {
        id: '00000000-0000-4000-8000-000000000002',
        position: 0,
      });
      const tiedFirst = makeCatalogoProduto(firstCategory.id, {
        id: '00000000-0000-4000-8000-000000000001',
        position: 0,
      });
      const inactive = makeCatalogoProduto(firstCategory.id, {
        position: 1,
        ativo: false,
      });
      const second = makeCatalogoProduto(secondCategory.id, { position: 0 });
      await repo.createProduto(second);
      await repo.createProduto(inactive);
      await repo.createProduto(first);
      await repo.createProduto(tiedFirst);

      const result = await repo.findProdutosAtivosComCategoria();
      expect(result.map(({ produto }) => produto.id)).toEqual([tiedFirst.id, first.id, second.id]);
      expect(result.map(({ categoria }) => categoria.id)).toEqual([
        firstCategory.id,
        firstCategory.id,
        secondCategory.id,
      ]);
    });

    it('creates, updates and summarizes lists, counting inactive assigned products', async () => {
      const category = makeCatalogoCategoria();
      await repo.createCategoria(category);
      const inactiveProduct = makeCatalogoProduto(category.id, { ativo: false });
      await repo.createProduto(inactiveProduct);

      const activeList = makeCatalogoLista({ slug: 'ativa', position: 0 });
      const inactiveList = makeCatalogoLista({
        slug: 'inativa',
        position: 1,
        ativo: false,
      });
      await repo.createLista(activeList);
      await repo.createLista(inactiveList);
      await repo.replaceListaItens(activeList.id, [
        makeCatalogoListaItem(activeList.id, inactiveProduct.id),
      ]);

      expect(await repo.findListasResumo({ includeInactive: false })).toEqual([
        { lista: activeList, quantidadeItens: 1 },
      ]);
      expect(await repo.findListasResumo({ includeInactive: true })).toEqual([
        { lista: activeList, quantidadeItens: 1 },
        { lista: inactiveList, quantidadeItens: 0 },
      ]);

      const updated: CatalogoLista = {
        ...activeList,
        nome: 'Lista atualizada',
        atualizadoEm: UPDATED_AT,
      };
      expect(await repo.updateLista(updated)).toBe(true);
      expect((await repo.findListaByIdComItens(activeList.id))?.lista).toEqual(updated);
      expect(await repo.updateLista(makeCatalogoLista())).toBe(false);
    });

    it('allocates the next list position including inactive lists', async () => {
      expect(await repo.findNextListaPosition()).toBe(0);
      await repo.createLista(makeCatalogoLista({ position: 3, ativo: false }));
      await repo.createLista(makeCatalogoLista({ position: 1 }));
      expect(await repo.findNextListaPosition()).toBe(4);
    });

    it('allows tied list positions with UUID ordering and rejects negative positions', async () => {
      const later = makeCatalogoLista({
        id: '00000000-0000-4000-8000-000000000002',
        position: 0,
      });
      const earlier = makeCatalogoLista({
        id: '00000000-0000-4000-8000-000000000001',
        position: 0,
      });
      await repo.createLista(later);
      await repo.createLista(earlier);
      expect(
        (await repo.findListasResumo({ includeInactive: true })).map(({ lista }) => lista.id),
      ).toEqual([earlier.id, later.id]);
      await expect(repo.createLista(makeCatalogoLista({ position: -1 }))).rejects.toThrow();
    });

    it('replaces the complete item set in position order and empty input clears it', async () => {
      const category = makeCatalogoCategoria();
      await repo.createCategoria(category);
      const first = makeCatalogoProduto(category.id, { position: 0 });
      const second = makeCatalogoProduto(category.id, { position: 1 });
      await repo.createProduto(first);
      await repo.createProduto(second);
      const list = makeCatalogoLista();
      await repo.createLista(list);

      await expect(
        repo.replaceListaItens(list.id, [
          makeCatalogoListaItem(list.id, first.id, { position: -1 }),
        ]),
      ).rejects.toThrow();
      const itemAtOne = makeCatalogoListaItem(list.id, first.id, {
        quantidade: 2,
        position: 1,
      });
      const itemAtZero = makeCatalogoListaItem(list.id, second.id, {
        quantidade: 3,
        position: 0,
      });
      expect(await repo.replaceListaItens(list.id, [itemAtOne, itemAtZero])).toEqual({
        status: 'replaced',
      });
      expect((await repo.findListaByIdComItens(list.id))?.itens.map(({ item }) => item)).toEqual([
        itemAtZero,
        itemAtOne,
      ]);

      expect(await repo.replaceListaItens(list.id, [])).toEqual({ status: 'replaced' });
      expect((await repo.findListaByIdComItens(list.id))?.itens).toEqual([]);
    });

    it('reports missing list/products and preserves the previous set on a failed replacement', async () => {
      const category = makeCatalogoCategoria();
      await repo.createCategoria(category);
      const product = makeCatalogoProduto(category.id);
      await repo.createProduto(product);
      const list = makeCatalogoLista();
      await repo.createLista(list);
      const original = makeCatalogoListaItem(list.id, product.id);
      await repo.replaceListaItens(list.id, [original]);

      expect(
        await repo.replaceListaItens(randomUUID(), [
          makeCatalogoListaItem(randomUUID(), product.id),
        ]),
      ).toEqual({ status: 'list_not_found' });

      const missingA = randomUUID();
      const missingB = randomUUID();
      const failed = await repo.replaceListaItens(list.id, [
        makeCatalogoListaItem(list.id, missingB, { position: 1 }),
        makeCatalogoListaItem(list.id, missingA, { position: 0 }),
        makeCatalogoListaItem(list.id, missingB, { position: 2 }),
      ]);
      expect(failed).toEqual({
        status: 'products_not_found',
        idsProdutos: [missingA, missingB].sort(),
      });
      expect((await repo.findListaByIdComItens(list.id))?.itens.map(({ item }) => item)).toEqual([
        original,
      ]);
    });

    it('keeps inactive products in admin detail but suppresses them from active public lists', async () => {
      const category = makeCatalogoCategoria();
      await repo.createCategoria(category);
      const activeProduct = makeCatalogoProduto(category.id, { position: 0 });
      const inactiveProduct = makeCatalogoProduto(category.id, {
        position: 1,
        ativo: false,
      });
      await repo.createProduto(activeProduct);
      await repo.createProduto(inactiveProduct);

      const populated = makeCatalogoLista({ position: 0 });
      const becomesEmpty = makeCatalogoLista({ position: 1 });
      const inactiveList = makeCatalogoLista({ position: 2, ativo: false });
      await repo.createLista(populated);
      await repo.createLista(becomesEmpty);
      await repo.createLista(inactiveList);
      await repo.replaceListaItens(populated.id, [
        makeCatalogoListaItem(populated.id, activeProduct.id, { position: 0 }),
        makeCatalogoListaItem(populated.id, inactiveProduct.id, { position: 1 }),
      ]);
      await repo.replaceListaItens(becomesEmpty.id, [
        makeCatalogoListaItem(becomesEmpty.id, inactiveProduct.id),
      ]);

      expect((await repo.findListaByIdComItens(populated.id))?.itens).toHaveLength(2);
      const publicLists = await repo.findListasAtivasComItensAtivos();
      expect(publicLists.map(({ lista }) => lista.id)).toEqual([populated.id, becomesEmpty.id]);
      expect(publicLists[0]?.itens.map(({ produto }) => produto.id)).toEqual([activeProduct.id]);
      expect(publicLists[1]?.itens).toEqual([]);
    });

    it('emits portable db.catalogo spans', async () => {
      const category = makeCatalogoCategoria();
      await repo.createCategoria(category);
      await repo.findCategoriasComContagem();

      const createSpan = options
        .getSpans()
        .find((span) => span.name === 'db.catalogo.createCategoria');
      expect(createSpan).toBeDefined();
      expect(createSpan?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(createSpan?.attributes['db.collection.name']).toBe('catalogo');

      const readSpan = options
        .getSpans()
        .find((span) => span.name === 'db.catalogo.findCategoriasComContagem');
      expect(readSpan).toBeDefined();
      expect(readSpan?.attributes['db.operation.name']).toBe('SELECT');
    });
  });
}
