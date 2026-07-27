import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  CatalogoCategoria,
  CatalogoCategoriaComContagem,
  CatalogoLista,
  CatalogoListaComItens,
  CatalogoListaItem,
  CatalogoListaItemComProduto,
  CatalogoListaResumo,
  CatalogoProduto,
  CatalogoProdutoComCategoria,
  CatalogoRepository,
  DeleteCatalogoCategoriaVaziaOutcome,
  FindCatalogoProdutosPageInput,
  FindCatalogoProdutosPageOutput,
  ReplaceCatalogoListaItensOutcome,
} from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'catalogo',
} as const;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneCategoria(value: CatalogoCategoria): CatalogoCategoria {
  return { ...value, criadoEm: new Date(value.criadoEm) };
}

function cloneProduto(value: CatalogoProduto): CatalogoProduto {
  return {
    ...value,
    criadoEm: new Date(value.criadoEm),
    atualizadoEm: new Date(value.atualizadoEm),
  };
}

function cloneLista(value: CatalogoLista): CatalogoLista {
  return {
    ...value,
    criadoEm: new Date(value.criadoEm),
    atualizadoEm: new Date(value.atualizadoEm),
  };
}

function cloneItem(value: CatalogoListaItem): CatalogoListaItem {
  return { ...value };
}

async function withMemorySpan<T>(
  operationName: string,
  dbOperation: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`db.catalogo.${operationName}`, async (span) => {
    span.setAttributes({ ...DB_ATTRS, 'db.operation.name': dbOperation });
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * In-memory catalogue adapter used by unit tests and local dependency
 * injection. It mirrors Postgres FK/unique/check behaviour closely enough for
 * the shared conformance suite rather than silently accepting invalid state.
 */
export class CatalogoRepositoryMemory implements CatalogoRepository {
  private readonly categorias = new Map<string, CatalogoCategoria>();
  private readonly produtos = new Map<string, CatalogoProduto>();
  private readonly listas = new Map<string, CatalogoLista>();
  private readonly itensByLista = new Map<string, readonly CatalogoListaItem[]>();

  async createCategoria(categoria: CatalogoCategoria): Promise<void> {
    return withMemorySpan('createCategoria', 'INSERT', () => {
      this.assertPositionValid(categoria.position, 'categoria');
      this.assertCategoriaUnique(categoria);
      this.categorias.set(categoria.id, cloneCategoria(categoria));
    });
  }

  async updateCategoria(categoria: CatalogoCategoria): Promise<boolean> {
    return withMemorySpan('updateCategoria', 'UPDATE', () => {
      if (!this.categorias.has(categoria.id)) return false;
      this.assertPositionValid(categoria.position, 'categoria');
      this.assertCategoriaUnique(categoria, categoria.id);
      this.categorias.set(categoria.id, cloneCategoria(categoria));
      return true;
    });
  }

  async findCategoriaById(id: string): Promise<CatalogoCategoria | undefined> {
    return withMemorySpan('findCategoriaById', 'SELECT', () => {
      const categoria = this.categorias.get(id);
      return categoria ? cloneCategoria(categoria) : undefined;
    });
  }

  async findCategoriasComContagem(): Promise<readonly CatalogoCategoriaComContagem[]> {
    return withMemorySpan('findCategoriasComContagem', 'SELECT', () =>
      [...this.categorias.values()]
        .sort((a, b) => a.position - b.position || compareText(a.id, b.id))
        .map((categoria) => ({
          categoria: cloneCategoria(categoria),
          quantidadeProdutos: [...this.produtos.values()].filter(
            (produto) => produto.idCategoria === categoria.id,
          ).length,
        })),
    );
  }

  async deleteCategoriaVazia(id: string): Promise<DeleteCatalogoCategoriaVaziaOutcome> {
    return withMemorySpan('deleteCategoriaVazia', 'DELETE', () => {
      if (!this.categorias.has(id)) return 'not_found';
      if ([...this.produtos.values()].some((produto) => produto.idCategoria === id)) {
        return 'not_empty';
      }
      this.categorias.delete(id);
      return 'deleted';
    });
  }

  async createProduto(produto: CatalogoProduto): Promise<void> {
    return withMemorySpan('createProduto', 'INSERT', () => {
      this.assertProdutoValid(produto);
      this.assertProdutoUnique(produto);
      this.produtos.set(produto.id, cloneProduto(produto));
    });
  }

  async updateProduto(produto: CatalogoProduto): Promise<boolean> {
    return withMemorySpan('updateProduto', 'UPDATE', () => {
      if (!this.produtos.has(produto.id)) return false;
      this.assertProdutoValid(produto);
      this.assertProdutoUnique(produto, produto.id);
      this.produtos.set(produto.id, cloneProduto(produto));
      return true;
    });
  }

  async findProdutoById(id: string): Promise<CatalogoProduto | undefined> {
    return withMemorySpan('findProdutoById', 'SELECT', () => {
      const produto = this.produtos.get(id);
      return produto ? cloneProduto(produto) : undefined;
    });
  }

  async findNextProdutoPosition(idCategoria: string): Promise<number> {
    return withMemorySpan('findNextProdutoPosition', 'SELECT', () => {
      const positions = [...this.produtos.values()]
        .filter((produto) => produto.idCategoria === idCategoria)
        .map((produto) => produto.position);
      return positions.length === 0 ? 0 : Math.max(...positions) + 1;
    });
  }

  async findProdutosPage(
    input: FindCatalogoProdutosPageInput,
  ): Promise<FindCatalogoProdutosPageOutput> {
    return withMemorySpan('findProdutosPage', 'SELECT', () => {
      const search = input.search?.trim().toLocaleLowerCase('pt-BR') ?? '';
      const matching = [...this.produtos.values()]
        .filter((produto) => {
          if (!input.includeInactive && !produto.ativo) return false;
          if (input.idCategoria !== undefined && produto.idCategoria !== input.idCategoria) {
            return false;
          }
          return search === '' || produto.nome.toLocaleLowerCase('pt-BR').includes(search);
        })
        .map((produto) => this.produtoComCategoria(produto))
        .sort(
          (a, b) =>
            a.categoria.position - b.categoria.position ||
            compareText(a.categoria.id, b.categoria.id) ||
            a.produto.position - b.produto.position ||
            compareText(a.produto.id, b.produto.id),
        );

      return {
        items: matching.slice(input.offset, input.offset + input.limit),
        total: matching.length,
      };
    });
  }

  async findProdutosAtivosComCategoria(): Promise<readonly CatalogoProdutoComCategoria[]> {
    return withMemorySpan('findProdutosAtivosComCategoria', 'SELECT', () =>
      [...this.produtos.values()]
        .filter((produto) => produto.ativo)
        .map((produto) => this.produtoComCategoria(produto))
        .sort(
          (a, b) =>
            a.categoria.position - b.categoria.position ||
            compareText(a.categoria.id, b.categoria.id) ||
            a.produto.position - b.produto.position ||
            compareText(a.produto.id, b.produto.id),
        ),
    );
  }

  async createLista(lista: CatalogoLista): Promise<void> {
    return withMemorySpan('createLista', 'INSERT', () => {
      this.assertPositionValid(lista.position, 'lista');
      this.assertListaUnique(lista);
      this.listas.set(lista.id, cloneLista(lista));
      this.itensByLista.set(lista.id, []);
    });
  }

  async updateLista(lista: CatalogoLista): Promise<boolean> {
    return withMemorySpan('updateLista', 'UPDATE', () => {
      if (!this.listas.has(lista.id)) return false;
      this.assertPositionValid(lista.position, 'lista');
      this.assertListaUnique(lista, lista.id);
      this.listas.set(lista.id, cloneLista(lista));
      return true;
    });
  }

  async findNextListaPosition(): Promise<number> {
    return withMemorySpan('findNextListaPosition', 'SELECT', () => {
      const positions = [...this.listas.values()].map((lista) => lista.position);
      return positions.length === 0 ? 0 : Math.max(...positions) + 1;
    });
  }

  async findListaByIdComItens(id: string): Promise<CatalogoListaComItens | undefined> {
    return withMemorySpan('findListaByIdComItens', 'SELECT', () => {
      const lista = this.listas.get(id);
      return lista ? this.listaComItens(lista, false) : undefined;
    });
  }

  async findListasResumo(input: {
    readonly includeInactive: boolean;
  }): Promise<readonly CatalogoListaResumo[]> {
    return withMemorySpan('findListasResumo', 'SELECT', () =>
      [...this.listas.values()]
        .filter((lista) => input.includeInactive || lista.ativo)
        .sort((a, b) => a.position - b.position || compareText(a.id, b.id))
        .map((lista) => ({
          lista: cloneLista(lista),
          quantidadeItens: this.itensByLista.get(lista.id)?.length ?? 0,
        })),
    );
  }

  async replaceListaItens(
    idLista: string,
    itens: readonly CatalogoListaItem[],
  ): Promise<ReplaceCatalogoListaItensOutcome> {
    return withMemorySpan('replaceListaItens', 'REPLACE', () => {
      if (!this.listas.has(idLista)) return { status: 'list_not_found' };

      const missingIds = [
        ...new Set(
          itens.filter((item) => !this.produtos.has(item.idProduto)).map((item) => item.idProduto),
        ),
      ].sort(compareText);
      if (missingIds.length > 0) {
        return { status: 'products_not_found', idsProdutos: missingIds };
      }

      this.assertListaItensValid(idLista, itens);
      // The validation above happens before this single swap. A failed
      // replacement cannot partially mutate the previous item set.
      this.itensByLista.set(
        idLista,
        itens.map(cloneItem).sort((a, b) => a.position - b.position || compareText(a.id, b.id)),
      );
      return { status: 'replaced' };
    });
  }

  async findListasAtivasComItensAtivos(): Promise<readonly CatalogoListaComItens[]> {
    return withMemorySpan('findListasAtivasComItensAtivos', 'SELECT', () =>
      [...this.listas.values()]
        .filter((lista) => lista.ativo)
        .sort((a, b) => a.position - b.position || compareText(a.id, b.id))
        .map((lista) => this.listaComItens(lista, true)),
    );
  }

  private produtoComCategoria(produto: CatalogoProduto): CatalogoProdutoComCategoria {
    const categoria = this.categorias.get(produto.idCategoria);
    if (!categoria) {
      throw new Error(`Categoria ${produto.idCategoria} não encontrada`);
    }
    return {
      produto: cloneProduto(produto),
      categoria: cloneCategoria(categoria),
    };
  }

  private listaComItens(
    lista: CatalogoLista,
    somenteProdutosAtivos: boolean,
  ): CatalogoListaComItens {
    const itens: CatalogoListaItemComProduto[] = [];
    for (const item of this.itensByLista.get(lista.id) ?? []) {
      const produto = this.produtos.get(item.idProduto);
      if (!produto) {
        throw new Error(`Produto ${item.idProduto} não encontrado`);
      }
      if (somenteProdutosAtivos && !produto.ativo) continue;
      itens.push({ item: cloneItem(item), produto: cloneProduto(produto) });
    }
    itens.sort((a, b) => a.item.position - b.item.position || compareText(a.item.id, b.item.id));
    return { lista: cloneLista(lista), itens };
  }

  private assertCategoriaUnique(categoria: CatalogoCategoria, exceptId?: string): void {
    if (this.categorias.has(categoria.id) && categoria.id !== exceptId) {
      throw new Error(`Categoria ${categoria.id} já existe`);
    }
    for (const existing of this.categorias.values()) {
      if (existing.id === exceptId) continue;
      if (existing.slug === categoria.slug) {
        throw new Error(`Slug de categoria ${categoria.slug} já existe`);
      }
    }
  }

  private assertProdutoValid(produto: CatalogoProduto): void {
    if (!this.categorias.has(produto.idCategoria)) {
      throw new Error(`Categoria ${produto.idCategoria} não encontrada`);
    }
    if (produto.precoCents <= 0 || !Number.isSafeInteger(produto.precoCents)) {
      throw new Error('precoCents deve ser um inteiro positivo');
    }
    if (produto.quantidadeSugerida <= 0 || !Number.isInteger(produto.quantidadeSugerida)) {
      throw new Error('quantidadeSugerida deve ser um inteiro positivo');
    }
    this.assertPositionValid(produto.position, 'produto');
  }

  private assertProdutoUnique(produto: CatalogoProduto, exceptId?: string): void {
    if (this.produtos.has(produto.id) && produto.id !== exceptId) {
      throw new Error(`Produto ${produto.id} já existe`);
    }
    for (const existing of this.produtos.values()) {
      if (existing.id === exceptId) continue;
      if (produto.idLegado !== null && existing.idLegado === produto.idLegado) {
        throw new Error(`ID legado ${produto.idLegado} já existe`);
      }
    }
  }

  private assertListaUnique(lista: CatalogoLista, exceptId?: string): void {
    if (this.listas.has(lista.id) && lista.id !== exceptId) {
      throw new Error(`Lista ${lista.id} já existe`);
    }
    for (const existing of this.listas.values()) {
      if (existing.id === exceptId) continue;
      if (lista.slug !== null && existing.slug === lista.slug) {
        throw new Error(`Slug de lista ${lista.slug} já existe`);
      }
    }
  }

  private assertListaItensValid(idLista: string, itens: readonly CatalogoListaItem[]): void {
    const idsInOtherLists = new Set(
      [...this.itensByLista.entries()]
        .filter(([existingIdLista]) => existingIdLista !== idLista)
        .flatMap(([, existingItems]) => existingItems.map((item) => item.id)),
    );
    const ids = new Set<string>();
    const idsProdutos = new Set<string>();
    const positions = new Set<number>();
    for (const item of itens) {
      if (item.idLista !== idLista) {
        throw new Error(`Item ${item.id} pertence à lista ${item.idLista}, não ${idLista}`);
      }
      if (item.quantidade <= 0 || !Number.isInteger(item.quantidade)) {
        throw new Error(`Quantidade do item ${item.id} deve ser um inteiro positivo`);
      }
      if (idsInOtherLists.has(item.id)) {
        throw new Error(`Item ${item.id} já existe em outra lista`);
      }
      if (ids.has(item.id)) throw new Error(`Item ${item.id} duplicado`);
      if (idsProdutos.has(item.idProduto)) {
        throw new Error(`Produto ${item.idProduto} duplicado na lista ${idLista}`);
      }
      if (positions.has(item.position)) {
        throw new Error(`Posição ${item.position} duplicada na lista ${idLista}`);
      }
      this.assertPositionValid(item.position, 'item de lista');
      ids.add(item.id);
      idsProdutos.add(item.idProduto);
      positions.add(item.position);
    }
  }

  private assertPositionValid(position: number, entity: string): void {
    if (!Number.isInteger(position) || position < 0) {
      throw new Error(`Posição de ${entity} deve ser um inteiro não negativo`);
    }
  }
}
