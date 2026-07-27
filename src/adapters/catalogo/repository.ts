/**
 * Persistence records for the editable EuNeném catalogue.
 *
 * This is deliberately an infrastructure port rather than a fabricated
 * aggregate: the admin catalogue is a large read/write model spanning
 * categories, products and ready-made lists. Callers own IDs and timestamps
 * so memory and Postgres adapters expose the same deterministic contract.
 */
export interface CatalogoCategoria {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly position: number;
  readonly criadoEm: Date;
}

export interface CatalogoProduto {
  readonly id: string;
  readonly idLegado: string | null;
  readonly nome: string;
  readonly precoCents: number;
  readonly quantidadeSugerida: number;
  readonly emoji: string;
  readonly bgColor: string;
  readonly idCategoria: string;
  readonly position: number;
  readonly imageUrl: string | null;
  readonly popularidade: number | null;
  readonly ativo: boolean;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CatalogoLista {
  readonly id: string;
  readonly slug: string | null;
  readonly nome: string;
  readonly descricao: string | null;
  readonly imageUrl: string | null;
  readonly position: number;
  readonly ativo: boolean;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CatalogoListaItem {
  readonly id: string;
  readonly idLista: string;
  readonly idProduto: string;
  readonly quantidade: number;
  readonly position: number;
}

export interface CatalogoProdutoComCategoria {
  readonly produto: CatalogoProduto;
  readonly categoria: CatalogoCategoria;
}

export interface CatalogoListaItemComProduto {
  readonly item: CatalogoListaItem;
  readonly produto: CatalogoProduto;
}

export interface CatalogoListaComItens {
  readonly lista: CatalogoLista;
  readonly itens: readonly CatalogoListaItemComProduto[];
}

export interface CatalogoCategoriaComContagem {
  readonly categoria: CatalogoCategoria;
  /** Includes active and inactive products assigned to the category. */
  readonly quantidadeProdutos: number;
}

export interface CatalogoListaResumo {
  readonly lista: CatalogoLista;
  /** Includes active and inactive products assigned to the list. */
  readonly quantidadeItens: number;
}

/**
 * Mutable product fields accepted by the persistence boundary.
 *
 * This is deliberately a patch rather than a complete record: admin edits
 * and activation toggles may race, and a read/merge/full-write cycle can
 * otherwise restore fields changed by the concurrent request.
 */
export type UpdateCatalogoProdutoPatch = Readonly<
  Partial<
    Pick<
      CatalogoProduto,
      | 'idLegado'
      | 'nome'
      | 'precoCents'
      | 'quantidadeSugerida'
      | 'emoji'
      | 'bgColor'
      | 'idCategoria'
      | 'position'
      | 'imageUrl'
      | 'popularidade'
      | 'ativo'
    >
  > & {
    atualizadoEm: Date;
  }
>;

/** Mutable ready-list fields with the same atomic patch semantics. */
export type UpdateCatalogoListaPatch = Readonly<
  Partial<
    Pick<CatalogoLista, 'slug' | 'nome' | 'descricao' | 'imageUrl' | 'position' | 'ativo'>
  > & {
    atualizadoEm: Date;
  }
>;

export interface FindCatalogoProdutosPageInput {
  /**
   * Case-insensitive literal substring of `nome`. Pattern-language
   * metacharacters such as `%` and `_` are ordinary characters.
   */
  readonly search?: string;
  readonly idCategoria?: string;
  readonly includeInactive: boolean;
  readonly offset: number;
  readonly limit: number;
}

export interface FindCatalogoProdutosPageOutput {
  readonly items: readonly CatalogoProdutoComCategoria[];
  /** Count after filters and before pagination. */
  readonly total: number;
}

export type DeleteCatalogoCategoriaVaziaOutcome = 'deleted' | 'not_found' | 'not_empty';

export type ReplaceCatalogoListaItensOutcome =
  | { readonly status: 'replaced' }
  | { readonly status: 'list_not_found' }
  | {
      readonly status: 'products_not_found';
      readonly idsProdutos: readonly string[];
    };

/**
 * Stable port-level conflict surfaced by both adapters when a catalogue
 * category slug is already in use. Transport callers map this type to their
 * own conflict vocabulary without parsing database or localized messages.
 */
export class CatalogoConflictError extends Error {
  constructor(
    readonly field: 'categoria.slug',
    readonly value: string,
  ) {
    super(`Valor de catálogo já existe para ${field}`);
    this.name = 'CatalogoConflictError';
  }
}

/**
 * Persistence port used by the catalogue administration and public read
 * routers. Creates receive complete records. Updates receive field patches
 * so adapters can perform one atomic UPDATE without overwriting concurrent
 * changes to unrelated fields. Route/use-case code owns validation, UUID
 * generation and timestamps.
 */
export interface CatalogoRepository {
  createCategoria(categoria: CatalogoCategoria): Promise<void>;
  updateCategoria(categoria: CatalogoCategoria): Promise<boolean>;
  findCategoriaById(id: string): Promise<CatalogoCategoria | undefined>;
  findCategoriasComContagem(): Promise<readonly CatalogoCategoriaComContagem[]>;
  /**
   * Atomically checks for products (including inactive ones) and deletes only
   * when the category is empty.
   */
  deleteCategoriaVazia(id: string): Promise<DeleteCatalogoCategoriaVaziaOutcome>;

  createProduto(produto: CatalogoProduto): Promise<void>;
  updateProduto(
    id: string,
    patch: UpdateCatalogoProdutoPatch,
  ): Promise<CatalogoProduto | undefined>;
  findProdutoById(id: string): Promise<CatalogoProduto | undefined>;
  /** Next append-only position in a category, including inactive products. */
  findNextProdutoPosition(idCategoria: string): Promise<number>;
  findProdutosPage(input: FindCatalogoProdutosPageInput): Promise<FindCatalogoProdutosPageOutput>;
  /**
   * Public catalogue projection. Only active products are returned, ordered
   * by category position then product position.
   */
  findProdutosAtivosComCategoria(): Promise<readonly CatalogoProdutoComCategoria[]>;

  createLista(lista: CatalogoLista): Promise<void>;
  updateLista(id: string, patch: UpdateCatalogoListaPatch): Promise<CatalogoLista | undefined>;
  /** Next global append-only position, including inactive lists. */
  findNextListaPosition(): Promise<number>;
  findListaByIdComItens(id: string): Promise<CatalogoListaComItens | undefined>;
  findListasResumo(input: {
    readonly includeInactive: boolean;
  }): Promise<readonly CatalogoListaResumo[]>;
  /**
   * Replaces the complete item set in one transaction. Empty input clears the
   * list. Missing products leave the previous set untouched.
   */
  replaceListaItens(
    idLista: string,
    itens: readonly CatalogoListaItem[],
  ): Promise<ReplaceCatalogoListaItensOutcome>;
  /**
   * Public ready-list projection. Inactive lists and products are suppressed;
   * active lists remain present when all of their items are inactive.
   */
  findListasAtivasComItensAtivos(): Promise<readonly CatalogoListaComItens[]>;
}
