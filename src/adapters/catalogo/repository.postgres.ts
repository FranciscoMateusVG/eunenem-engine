import { SpanStatusCode, trace } from '@opentelemetry/api';
import { type Selectable, sql, type Transaction } from 'kysely';
import type { Database } from '../database.js';
import type { DB } from '../db-types.generated.js';
import type {
  CatalogoCategoria,
  CatalogoCategoriaComContagem,
  CatalogoInitialCampaignTemplate,
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
  SetInitialCampaignDefaultOutcome,
  UpdateCatalogoListaPatch,
  UpdateCatalogoProdutoPatch,
} from './repository.js';
import { CatalogoConflictError, CatalogoInitialCampaignDefaultInvalidError } from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'catalogo',
} as const;

type CategoriaRow = Selectable<import('../db-types.generated.js').CatalogoCategorias>;
type ProdutoRow = Selectable<import('../db-types.generated.js').CatalogoProdutos>;
type ListaRow = Selectable<import('../db-types.generated.js').CatalogoListas>;
type ListaItemRow = Selectable<import('../db-types.generated.js').CatalogoListaItens>;

interface PostgresError {
  readonly code?: string;
  readonly constraint?: string;
}

function isCategoriaSlugUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgError = error as PostgresError;
  return pgError.code === '23505' && pgError.constraint === 'catalogo_categorias_slug_key';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function int8ToSafeNumber(value: string | number | bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} is outside JavaScript's safe integer range`);
  }
  return parsed;
}

function categoriaFromRow(row: CategoriaRow): CatalogoCategoria {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    position: row.position,
    criadoEm: row.criado_em,
  };
}

function produtoFromRow(row: ProdutoRow): CatalogoProduto {
  return {
    id: row.id,
    idLegado: row.id_legado,
    nome: row.nome,
    precoCents: int8ToSafeNumber(row.preco_cents, 'catalogo_produtos.preco_cents'),
    quantidadeSugerida: row.quantidade_sugerida,
    emoji: row.emoji,
    bgColor: row.bg_color,
    idCategoria: row.id_categoria,
    position: row.position,
    imageUrl: row.image_url,
    popularidade: row.popularidade,
    ativo: row.ativo,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function listaFromRow(row: ListaRow): CatalogoLista {
  return {
    id: row.id,
    slug: row.slug,
    nome: row.nome,
    descricao: row.descricao,
    imageUrl: row.image_url,
    position: row.position,
    ativo: row.ativo,
    aplicarCampanhaInicial: row.aplicar_campanha_inicial,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

type CatalogExecutor = Database | Transaction<DB>;

async function acquireInitialCampaignDefaultLock(executor: CatalogExecutor): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('catalogo-initial-campaign-default', 0))`.execute(
    executor,
  );
}

function initialTemplateInvalidReason(
  template: CatalogoListaComItens,
): 'inactive' | 'empty' | 'invalid_items' | null {
  if (!template.lista.ativo) return 'inactive';
  if (template.itens.length === 0) return 'empty';
  const group = template.lista.slug ?? template.lista.id;
  if (
    template.itens.length > 50 ||
    group.length < 1 ||
    group.length > 60 ||
    template.itens.some(({ item, produto }) => {
      const image = produto.imageUrl;
      return (
        produto.nome.trim().length < 1 ||
        produto.nome.trim().length > 120 ||
        !Number.isSafeInteger(produto.precoCents) ||
        produto.precoCents < 1_000 ||
        !Number.isInteger(item.quantidade) ||
        item.quantidade < 1 ||
        item.quantidade > 100 ||
        (image !== null && (image.trim().length < 1 || image.length > 500))
      );
    })
  ) {
    return 'invalid_items';
  }
  return null;
}

function listaItemFromRow(row: ListaItemRow): CatalogoListaItem {
  return {
    id: row.id,
    idLista: row.id_lista,
    idProduto: row.id_produto,
    quantidade: row.quantidade,
    position: row.position,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function withoutUndefined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function validateListaItens(idLista: string, itens: readonly CatalogoListaItem[]): void {
  const ids = new Set<string>();
  const idsProdutos = new Set<string>();
  const positions = new Set<number>();

  for (const item of itens) {
    if (item.idLista !== idLista) {
      throw new Error(`Item ${item.id} pertence à lista ${item.idLista}, não ${idLista}`);
    }
    if (!Number.isInteger(item.quantidade) || item.quantidade <= 0) {
      throw new Error(`Quantidade do item ${item.id} deve ser um inteiro positivo`);
    }
    if (ids.has(item.id)) throw new Error(`Item ${item.id} duplicado`);
    if (idsProdutos.has(item.idProduto)) {
      throw new Error(`Produto ${item.idProduto} duplicado na lista ${idLista}`);
    }
    if (positions.has(item.position)) {
      throw new Error(`Posição ${item.position} duplicada na lista ${idLista}`);
    }
    ids.add(item.id);
    idsProdutos.add(item.idProduto);
    positions.add(item.position);
  }
}

async function withPostgresSpan<T>(
  operationName: string,
  dbOperation: string,
  fn: () => Promise<T>,
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

async function loadTemplateByList(
  executor: CatalogExecutor,
  selector: { readonly kind: 'marked' } | { readonly kind: 'id'; readonly id: string },
): Promise<CatalogoListaComItens | undefined> {
  let query = executor
    .selectFrom('catalogo_listas as l')
    .leftJoin('catalogo_lista_itens as li', 'li.id_lista', 'l.id')
    .leftJoin('catalogo_produtos as p', (join) =>
      join.onRef('p.id', '=', 'li.id_produto').on('p.ativo', '=', true),
    )
    .selectAll('l')
    .select([
      'li.id as item_id',
      'li.id_lista as item_id_lista',
      'li.id_produto as item_id_produto',
      'li.quantidade as item_quantidade',
      'li.position as item_position',
      'p.id as produto_id',
      'p.id_legado as produto_id_legado',
      'p.nome as produto_nome',
      'p.preco_cents as produto_preco_cents',
      'p.quantidade_sugerida as produto_quantidade_sugerida',
      'p.emoji as produto_emoji',
      'p.bg_color as produto_bg_color',
      'p.id_categoria as produto_id_categoria',
      'p.position as produto_position',
      'p.image_url as produto_image_url',
      'p.popularidade as produto_popularidade',
      'p.ativo as produto_ativo',
      'p.criado_em as produto_criado_em',
      'p.atualizado_em as produto_atualizado_em',
    ])
    .orderBy('li.position', 'asc')
    .orderBy('li.id', 'asc');
  query =
    selector.kind === 'marked'
      ? query.where('l.aplicar_campanha_inicial', '=', true)
      : query.where('l.id', '=', selector.id);
  const rows = await query.execute();
  const first = rows[0];
  if (!first) return undefined;

  const itens: CatalogoListaItemComProduto[] = [];
  for (const row of rows) {
    // A LEFT JOIN row with no active product is deliberately omitted. The
    // initial campaign copies only products active in this coherent snapshot.
    if (
      row.item_id === null ||
      row.item_id_lista === null ||
      row.item_id_produto === null ||
      row.item_quantidade === null ||
      row.item_position === null ||
      row.produto_id === null ||
      row.produto_nome === null ||
      row.produto_preco_cents === null ||
      row.produto_quantidade_sugerida === null ||
      row.produto_emoji === null ||
      row.produto_bg_color === null ||
      row.produto_id_categoria === null ||
      row.produto_position === null ||
      row.produto_ativo === null ||
      row.produto_criado_em === null ||
      row.produto_atualizado_em === null
    ) {
      continue;
    }
    itens.push({
      item: {
        id: row.item_id,
        idLista: row.item_id_lista,
        idProduto: row.item_id_produto,
        quantidade: row.item_quantidade,
        position: row.item_position,
      },
      produto: produtoFromRow({
        id: row.produto_id,
        id_legado: row.produto_id_legado,
        nome: row.produto_nome,
        preco_cents: row.produto_preco_cents,
        quantidade_sugerida: row.produto_quantidade_sugerida,
        emoji: row.produto_emoji,
        bg_color: row.produto_bg_color,
        id_categoria: row.produto_id_categoria,
        position: row.produto_position,
        image_url: row.produto_image_url,
        popularidade: row.produto_popularidade,
        ativo: row.produto_ativo,
        criado_em: row.produto_criado_em,
        atualizado_em: row.produto_atualizado_em,
      }),
    });
  }
  return { lista: listaFromRow(first), itens };
}

function classifyInitialTemplate(
  template: CatalogoListaComItens | undefined,
): CatalogoInitialCampaignTemplate {
  if (!template) return { status: 'none' };
  const reason = initialTemplateInvalidReason(template);
  return reason ? { status: 'invalid_config', reason } : { status: 'ready', template };
}

async function assertMarkedTemplateValid(executor: CatalogExecutor): Promise<void> {
  const classified = classifyInitialTemplate(
    await loadTemplateByList(executor, { kind: 'marked' }),
  );
  if (classified.status === 'invalid_config') {
    throw new CatalogoInitialCampaignDefaultInvalidError(classified.reason);
  }
}

/**
 * PostgreSQL catalogue adapter.
 *
 * Reads carry explicit position + UUID tie-break ordering. The migration
 * intentionally does not make product positions unique: B2 appends positions
 * server-side, and deterministic reads remain safe during concurrent inserts.
 */
export class CatalogoRepositoryPostgres implements CatalogoRepository {
  constructor(private readonly db: Database) {}

  async createCategoria(categoria: CatalogoCategoria): Promise<void> {
    return withPostgresSpan('createCategoria', 'INSERT', async () => {
      try {
        await this.db
          .insertInto('catalogo_categorias')
          .values({
            id: categoria.id,
            slug: categoria.slug,
            label: categoria.label,
            position: categoria.position,
            criado_em: categoria.criadoEm,
          })
          .execute();
      } catch (error: unknown) {
        if (isCategoriaSlugUniqueViolation(error)) {
          throw new CatalogoConflictError('categoria.slug', categoria.slug);
        }
        throw error;
      }
    });
  }

  async updateCategoria(categoria: CatalogoCategoria): Promise<boolean> {
    return withPostgresSpan('updateCategoria', 'UPDATE', async () => {
      const result = await this.db
        .updateTable('catalogo_categorias')
        .set({
          slug: categoria.slug,
          label: categoria.label,
          position: categoria.position,
          criado_em: categoria.criadoEm,
        })
        .where('id', '=', categoria.id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }

  async findCategoriaById(id: string): Promise<CatalogoCategoria | undefined> {
    return withPostgresSpan('findCategoriaById', 'SELECT', async () => {
      const row = await this.db
        .selectFrom('catalogo_categorias')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? categoriaFromRow(row) : undefined;
    });
  }

  async findCategoriasComContagem(): Promise<readonly CatalogoCategoriaComContagem[]> {
    return withPostgresSpan('findCategoriasComContagem', 'SELECT', async () => {
      const rows = await this.db
        .selectFrom('catalogo_categorias as c')
        .leftJoin('catalogo_produtos as p', 'p.id_categoria', 'c.id')
        .selectAll('c')
        .select(({ fn }) => fn.count<string>('p.id').as('quantidade_produtos'))
        .groupBy('c.id')
        .orderBy('c.position', 'asc')
        .orderBy('c.id', 'asc')
        .execute();
      return rows.map((row) => ({
        categoria: categoriaFromRow(row),
        quantidadeProdutos: int8ToSafeNumber(
          row.quantidade_produtos,
          'catalogo_categorias.quantidade_produtos',
        ),
      }));
    });
  }

  async deleteCategoriaVazia(id: string): Promise<DeleteCatalogoCategoriaVaziaOutcome> {
    return withPostgresSpan('deleteCategoriaVazia', 'DELETE', async () =>
      this.db.transaction().execute(async (trx) => {
        const categoria = await trx
          .selectFrom('catalogo_categorias')
          .select('id')
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!categoria) return 'not_found';

        const produto = await trx
          .selectFrom('catalogo_produtos')
          .select('id')
          .where('id_categoria', '=', id)
          .limit(1)
          .executeTakeFirst();
        if (produto) return 'not_empty';

        await trx.deleteFrom('catalogo_categorias').where('id', '=', id).execute();
        return 'deleted';
      }),
    );
  }

  async createProduto(produto: CatalogoProduto): Promise<void> {
    return withPostgresSpan('createProduto', 'INSERT', async () => {
      await this.db
        .insertInto('catalogo_produtos')
        .values({
          id: produto.id,
          id_legado: produto.idLegado,
          nome: produto.nome,
          preco_cents: produto.precoCents,
          quantidade_sugerida: produto.quantidadeSugerida,
          emoji: produto.emoji,
          bg_color: produto.bgColor,
          id_categoria: produto.idCategoria,
          position: produto.position,
          image_url: produto.imageUrl,
          popularidade: produto.popularidade,
          ativo: produto.ativo,
          criado_em: produto.criadoEm,
          atualizado_em: produto.atualizadoEm,
        })
        .execute();
    });
  }

  async updateProduto(
    id: string,
    patch: UpdateCatalogoProdutoPatch,
  ): Promise<CatalogoProduto | undefined> {
    return withPostgresSpan('updateProduto', 'UPDATE', () =>
      this.db.transaction().execute(async (trx) => {
        await acquireInitialCampaignDefaultLock(trx);
        const row = await trx
          .updateTable('catalogo_produtos')
          .set(
            withoutUndefined({
              id_legado: patch.idLegado,
              nome: patch.nome,
              preco_cents: patch.precoCents,
              quantidade_sugerida: patch.quantidadeSugerida,
              emoji: patch.emoji,
              bg_color: patch.bgColor,
              id_categoria: patch.idCategoria,
              position: patch.position,
              image_url: patch.imageUrl,
              popularidade: patch.popularidade,
              ativo: patch.ativo,
              atualizado_em: patch.atualizadoEm,
            }),
          )
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        if (!row) return undefined;
        await assertMarkedTemplateValid(trx);
        return produtoFromRow(row);
      }),
    );
  }

  async findProdutoById(id: string): Promise<CatalogoProduto | undefined> {
    return withPostgresSpan('findProdutoById', 'SELECT', async () => {
      const row = await this.db
        .selectFrom('catalogo_produtos')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? produtoFromRow(row) : undefined;
    });
  }

  async findNextProdutoPosition(idCategoria: string): Promise<number> {
    return withPostgresSpan('findNextProdutoPosition', 'SELECT', async () => {
      const result = await this.db
        .selectFrom('catalogo_produtos')
        .select(sql<number>`coalesce(max(position) + 1, 0)`.as('next_position'))
        .where('id_categoria', '=', idCategoria)
        .executeTakeFirstOrThrow();
      return result.next_position;
    });
  }

  async findProdutosPage(
    input: FindCatalogoProdutosPageInput,
  ): Promise<FindCatalogoProdutosPageOutput> {
    return withPostgresSpan('findProdutosPage', 'SELECT', async () => {
      const search = input.search?.trim() ?? '';
      const pattern = `%${escapeLikePattern(search)}%`;
      let rowsQuery = this.db
        .selectFrom('catalogo_produtos as p')
        .innerJoin('catalogo_categorias as c', 'c.id', 'p.id_categoria')
        .selectAll('p')
        .select([
          'c.id as categoria_id',
          'c.slug as categoria_slug',
          'c.label as categoria_label',
          'c.position as categoria_position',
          'c.criado_em as categoria_criado_em',
        ]);
      let countQuery = this.db
        .selectFrom('catalogo_produtos as p')
        .innerJoin('catalogo_categorias as c', 'c.id', 'p.id_categoria')
        .select(({ fn }) => fn.countAll<string>().as('total'));

      if (!input.includeInactive) {
        rowsQuery = rowsQuery.where('p.ativo', '=', true);
        countQuery = countQuery.where('p.ativo', '=', true);
      }
      if (input.idCategoria !== undefined) {
        rowsQuery = rowsQuery.where('p.id_categoria', '=', input.idCategoria);
        countQuery = countQuery.where('p.id_categoria', '=', input.idCategoria);
      }
      if (search !== '') {
        const literalSearch = sql<boolean>`${sql.ref('p.nome')} ILIKE ${pattern} ESCAPE '\\'`;
        rowsQuery = rowsQuery.where(literalSearch);
        countQuery = countQuery.where(literalSearch);
      }

      const rows = await rowsQuery
        .orderBy('c.position', 'asc')
        .orderBy('c.id', 'asc')
        .orderBy('p.position', 'asc')
        .orderBy('p.id', 'asc')
        .offset(input.offset)
        .limit(input.limit)
        .execute();

      const countRow = await countQuery.executeTakeFirstOrThrow();

      return {
        items: rows.map((row) => ({
          produto: produtoFromRow(row),
          categoria: {
            id: row.categoria_id,
            slug: row.categoria_slug,
            label: row.categoria_label,
            position: row.categoria_position,
            criadoEm: row.categoria_criado_em,
          },
        })),
        total: int8ToSafeNumber(countRow.total, 'catalogo_produtos.total'),
      };
    });
  }

  async findProdutosAtivosComCategoria(): Promise<readonly CatalogoProdutoComCategoria[]> {
    return withPostgresSpan('findProdutosAtivosComCategoria', 'SELECT', async () => {
      const rows = await this.db
        .selectFrom('catalogo_produtos as p')
        .innerJoin('catalogo_categorias as c', 'c.id', 'p.id_categoria')
        .selectAll('p')
        .select([
          'c.id as categoria_id',
          'c.slug as categoria_slug',
          'c.label as categoria_label',
          'c.position as categoria_position',
          'c.criado_em as categoria_criado_em',
        ])
        .where('p.ativo', '=', true)
        .orderBy('c.position', 'asc')
        .orderBy('c.id', 'asc')
        .orderBy('p.position', 'asc')
        .orderBy('p.id', 'asc')
        .execute();

      return rows.map((row) => ({
        produto: produtoFromRow(row),
        categoria: {
          id: row.categoria_id,
          slug: row.categoria_slug,
          label: row.categoria_label,
          position: row.categoria_position,
          criadoEm: row.categoria_criado_em,
        },
      }));
    });
  }

  async createLista(lista: CatalogoLista): Promise<void> {
    return withPostgresSpan('createLista', 'INSERT', async () => {
      await this.db
        .insertInto('catalogo_listas')
        .values({
          id: lista.id,
          slug: lista.slug,
          nome: lista.nome,
          descricao: lista.descricao,
          image_url: lista.imageUrl,
          position: lista.position,
          ativo: lista.ativo,
          criado_em: lista.criadoEm,
          atualizado_em: lista.atualizadoEm,
        })
        .execute();
    });
  }

  async updateLista(
    id: string,
    patch: UpdateCatalogoListaPatch,
  ): Promise<CatalogoLista | undefined> {
    return withPostgresSpan('updateLista', 'UPDATE', () =>
      this.db.transaction().execute(async (trx) => {
        await acquireInitialCampaignDefaultLock(trx);
        const row = await trx
          .updateTable('catalogo_listas')
          .set(
            withoutUndefined({
              slug: patch.slug,
              nome: patch.nome,
              descricao: patch.descricao,
              image_url: patch.imageUrl,
              position: patch.position,
              ativo: patch.ativo,
              atualizado_em: patch.atualizadoEm,
            }),
          )
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        if (!row) return undefined;
        await assertMarkedTemplateValid(trx);
        return listaFromRow(row);
      }),
    );
  }

  async findNextListaPosition(): Promise<number> {
    return withPostgresSpan('findNextListaPosition', 'SELECT', async () => {
      const result = await this.db
        .selectFrom('catalogo_listas')
        .select(sql<number>`coalesce(max(position) + 1, 0)`.as('next_position'))
        .executeTakeFirstOrThrow();
      return result.next_position;
    });
  }

  async findListaByIdComItens(id: string): Promise<CatalogoListaComItens | undefined> {
    return withPostgresSpan('findListaByIdComItens', 'SELECT', async () => {
      const row = await this.db
        .selectFrom('catalogo_listas')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return undefined;
      return {
        lista: listaFromRow(row),
        itens: await this.findItensComProdutos([id], false),
      };
    });
  }

  async findListasResumo(input: {
    readonly includeInactive: boolean;
  }): Promise<readonly CatalogoListaResumo[]> {
    return withPostgresSpan('findListasResumo', 'SELECT', async () => {
      let query = this.db
        .selectFrom('catalogo_listas as l')
        .leftJoin('catalogo_lista_itens as li', 'li.id_lista', 'l.id')
        .selectAll('l')
        .select(({ fn }) => fn.count<string>('li.id').as('quantidade_itens'))
        .groupBy('l.id')
        .orderBy('l.position', 'asc')
        .orderBy('l.id', 'asc');
      if (!input.includeInactive) query = query.where('l.ativo', '=', true);
      const rows = await query.execute();
      return rows.map((row) => ({
        lista: listaFromRow(row),
        quantidadeItens: int8ToSafeNumber(row.quantidade_itens, 'catalogo_listas.quantidade_itens'),
      }));
    });
  }

  async replaceListaItens(
    idLista: string,
    itens: readonly CatalogoListaItem[],
  ): Promise<ReplaceCatalogoListaItensOutcome> {
    return withPostgresSpan('replaceListaItens', 'REPLACE', async () => {
      return this.db.transaction().execute(async (trx) => {
        await acquireInitialCampaignDefaultLock(trx);
        const lista = await trx
          .selectFrom('catalogo_listas')
          .select('id')
          .where('id', '=', idLista)
          .forUpdate()
          .executeTakeFirst();
        if (!lista) return { status: 'list_not_found' };

        const requestedProductIds = [...new Set(itens.map((item) => item.idProduto))];
        let foundProductIds = new Set<string>();
        if (requestedProductIds.length > 0) {
          const found = await trx
            .selectFrom('catalogo_produtos')
            .select('id')
            .where('id', 'in', requestedProductIds)
            .execute();
          foundProductIds = new Set(found.map(({ id }) => id));
        }
        const missingIds = requestedProductIds
          .filter((id) => !foundProductIds.has(id))
          .sort(compareText);
        if (missingIds.length > 0) {
          return { status: 'products_not_found', idsProdutos: missingIds };
        }

        validateListaItens(idLista, itens);
        await trx.deleteFrom('catalogo_lista_itens').where('id_lista', '=', idLista).execute();
        if (itens.length > 0) {
          await trx
            .insertInto('catalogo_lista_itens')
            .values(
              itens.map((item) => ({
                id: item.id,
                id_lista: item.idLista,
                id_produto: item.idProduto,
                quantidade: item.quantidade,
                position: item.position,
              })),
            )
            .execute();
        }
        await assertMarkedTemplateValid(trx);
        return { status: 'replaced' };
      });
    });
  }

  async findListasAtivasComItensAtivos(): Promise<readonly CatalogoListaComItens[]> {
    return withPostgresSpan('findListasAtivasComItensAtivos', 'SELECT', async () => {
      const listas = await this.db
        .selectFrom('catalogo_listas')
        .selectAll()
        .where('ativo', '=', true)
        .orderBy('position', 'asc')
        .orderBy('id', 'asc')
        .execute();
      if (listas.length === 0) return [];

      const itens = await this.findItensComProdutos(
        listas.map(({ id }) => id),
        true,
      );
      const itensByLista = new Map<string, CatalogoListaItemComProduto[]>();
      for (const item of itens) {
        const bucket = itensByLista.get(item.item.idLista) ?? [];
        bucket.push(item);
        itensByLista.set(item.item.idLista, bucket);
      }
      return listas.map((lista) => ({
        lista: listaFromRow(lista),
        itens: itensByLista.get(lista.id) ?? [],
      }));
    });
  }

  async findInitialCampaignTemplate(): Promise<CatalogoInitialCampaignTemplate> {
    return withPostgresSpan('findInitialCampaignTemplate', 'SELECT', async () =>
      classifyInitialTemplate(await loadTemplateByList(this.db, { kind: 'marked' })),
    );
  }

  async setInitialCampaignDefault(
    idLista: string | null,
    validateReady: (template: CatalogoListaComItens) => void,
  ): Promise<SetInitialCampaignDefaultOutcome> {
    return withPostgresSpan('setInitialCampaignDefault', 'UPDATE', () =>
      this.db.transaction().execute(async (trx) => {
        await acquireInitialCampaignDefaultLock(trx);
        if (idLista === null) {
          await trx
            .updateTable('catalogo_listas')
            .set({ aplicar_campanha_inicial: false })
            .where('aplicar_campanha_inicial', '=', true)
            .execute();
          return { status: 'updated', template: null };
        }

        const target = await trx
          .selectFrom('catalogo_listas')
          .select('id')
          .where('id', '=', idLista)
          .forUpdate()
          .executeTakeFirst();
        if (!target) return { status: 'not_found' };
        const template = await loadTemplateByList(trx, { kind: 'id', id: idLista });
        if (!template) return { status: 'not_found' };
        const reason = initialTemplateInvalidReason(template);
        if (reason) return { status: 'invalid_config', reason };
        validateReady(template);

        await trx
          .updateTable('catalogo_listas')
          .set({ aplicar_campanha_inicial: false })
          .where('aplicar_campanha_inicial', '=', true)
          .where('id', '!=', idLista)
          .execute();
        await trx
          .updateTable('catalogo_listas')
          .set({ aplicar_campanha_inicial: true })
          .where('id', '=', idLista)
          .execute();
        const selected = await loadTemplateByList(trx, { kind: 'id', id: idLista });
        if (!selected) {
          throw new Error('Lista selecionada desapareceu durante a atualização');
        }
        return {
          status: 'updated',
          template: selected,
        };
      }),
    );
  }

  private async findItensComProdutos(
    idsListas: readonly string[],
    somenteProdutosAtivos: boolean,
  ): Promise<readonly CatalogoListaItemComProduto[]> {
    if (idsListas.length === 0) return [];
    let query = this.db
      .selectFrom('catalogo_lista_itens as li')
      .innerJoin('catalogo_produtos as p', 'p.id', 'li.id_produto')
      .selectAll('li')
      .select([
        'p.id as produto_id',
        'p.id_legado as produto_id_legado',
        'p.nome as produto_nome',
        'p.preco_cents as produto_preco_cents',
        'p.quantidade_sugerida as produto_quantidade_sugerida',
        'p.emoji as produto_emoji',
        'p.bg_color as produto_bg_color',
        'p.id_categoria as produto_id_categoria',
        'p.position as produto_position',
        'p.image_url as produto_image_url',
        'p.popularidade as produto_popularidade',
        'p.ativo as produto_ativo',
        'p.criado_em as produto_criado_em',
        'p.atualizado_em as produto_atualizado_em',
      ])
      .where('li.id_lista', 'in', idsListas)
      .orderBy('li.id_lista', 'asc')
      .orderBy('li.position', 'asc')
      .orderBy('li.id', 'asc');
    if (somenteProdutosAtivos) query = query.where('p.ativo', '=', true);

    const rows = await query.execute();
    return rows.map((row) => ({
      item: listaItemFromRow(row),
      produto: produtoFromRow({
        id: row.produto_id,
        id_legado: row.produto_id_legado,
        nome: row.produto_nome,
        preco_cents: row.produto_preco_cents,
        quantidade_sugerida: row.produto_quantidade_sugerida,
        emoji: row.produto_emoji,
        bg_color: row.produto_bg_color,
        id_categoria: row.produto_id_categoria,
        position: row.produto_position,
        image_url: row.produto_image_url,
        popularidade: row.produto_popularidade,
        ativo: row.produto_ativo,
        criado_em: row.produto_criado_em,
        atualizado_em: row.produto_atualizado_em,
      }),
    }));
  }
}
