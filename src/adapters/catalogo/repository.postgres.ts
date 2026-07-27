import { SpanStatusCode, trace } from '@opentelemetry/api';
import { type Selectable, sql } from 'kysely';
import type { Database } from '../database.js';
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
  'db.system': 'postgresql',
  'db.collection.name': 'catalogo',
} as const;

type CategoriaRow = Selectable<import('../db-types.generated.js').CatalogoCategorias>;
type ProdutoRow = Selectable<import('../db-types.generated.js').CatalogoProdutos>;
type ListaRow = Selectable<import('../db-types.generated.js').CatalogoListas>;
type ListaItemRow = Selectable<import('../db-types.generated.js').CatalogoListaItens>;

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
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
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

  async updateProduto(produto: CatalogoProduto): Promise<boolean> {
    return withPostgresSpan('updateProduto', 'UPDATE', async () => {
      const result = await this.db
        .updateTable('catalogo_produtos')
        .set({
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
        .where('id', '=', produto.id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
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

  async updateLista(lista: CatalogoLista): Promise<boolean> {
    return withPostgresSpan('updateLista', 'UPDATE', async () => {
      const result = await this.db
        .updateTable('catalogo_listas')
        .set({
          slug: lista.slug,
          nome: lista.nome,
          descricao: lista.descricao,
          image_url: lista.imageUrl,
          position: lista.position,
          ativo: lista.ativo,
          criado_em: lista.criadoEm,
          atualizado_em: lista.atualizadoEm,
        })
        .where('id', '=', lista.id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
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
