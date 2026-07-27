import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import catalogSnapshot from './seed/20260727_045_catalog.json';
import listasSnapshot from './seed/20260727_045_listas-prontas.json';

type CatalogItem = {
  id: string;
  name: string;
  price: number;
  suggestedQty: number;
  emoji: string;
  bgColor: string;
  category: string;
  imageUrl: string | null;
  popularity?: number;
};

type ListaItem = Omit<CatalogItem, 'category' | 'popularity'>;

type Lista = {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  items: ListaItem[];
};

const CATEGORIES = [
  { slug: 'fraldas', label: 'fraldas' },
  { slug: 'higiene', label: 'higiene' },
  { slug: 'roupa', label: 'roupinhas' },
  { slug: 'soninho', label: 'soninho' },
  { slug: 'alimentacao', label: 'alimentação' },
  { slug: 'passeio', label: 'passeio' },
  { slug: 'brinquedo', label: 'brinquedos' },
  { slug: 'outros', label: 'outros' },
] as const;

const EXPECTED_PRODUCT_COUNT = 501;
const EXPECTED_LIST_COUNT = 5;
const EXPECTED_LIST_ITEM_COUNT = 77;

function fail(reason: string): never {
  throw new Error(`[catalogo migration seed] ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requiredString(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${path} must be a positive integer`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function parseCatalogItem(value: unknown, path: string): CatalogItem {
  if (!isRecord(value)) fail(`${path} must be an object`);
  const price = finiteNumber(value.price, `${path}.price`);
  const priceCents = Math.round(price * 100);
  // JSON decimal → IEEE-754 multiplication can leave ~1e-11 residue even
  // for valid two-decimal prices (for example 1279.90). The tolerance only
  // absorbs that representation noise; a third decimal remains far above it.
  if (priceCents <= 0 || Math.abs(price * 100 - priceCents) > 1e-7) {
    fail(`${path}.price must be positive and exactly representable in cents`);
  }
  const popularity =
    value.popularity === undefined
      ? undefined
      : finiteNumber(value.popularity, `${path}.popularity`);
  if (popularity !== undefined && (!Number.isInteger(popularity) || popularity < 0)) {
    fail(`${path}.popularity must be a non-negative integer when present`);
  }
  return {
    id: requiredString(value.id, `${path}.id`),
    name: requiredString(value.name, `${path}.name`),
    price,
    suggestedQty: positiveInteger(value.suggestedQty, `${path}.suggestedQty`),
    emoji: requiredString(value.emoji, `${path}.emoji`),
    bgColor: requiredString(value.bgColor, `${path}.bgColor`),
    category: requiredString(value.category, `${path}.category`),
    imageUrl: nullableString(value.imageUrl, `${path}.imageUrl`),
    ...(popularity === undefined ? {} : { popularity }),
  };
}

function parseListaItem(value: unknown, path: string): ListaItem {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return {
    id: requiredString(value.id, `${path}.id`),
    name: requiredString(value.name, `${path}.name`),
    price: finiteNumber(value.price, `${path}.price`),
    suggestedQty: positiveInteger(value.suggestedQty, `${path}.suggestedQty`),
    emoji: requiredString(value.emoji, `${path}.emoji`),
    bgColor: requiredString(value.bgColor, `${path}.bgColor`),
    imageUrl: nullableString(value.imageUrl, `${path}.imageUrl`),
  };
}

function parseLista(value: unknown, path: string): Lista {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (!Array.isArray(value.items)) fail(`${path}.items must be an array`);
  return {
    id: requiredString(value.id, `${path}.id`),
    title: requiredString(value.title, `${path}.title`),
    description: requiredString(value.description, `${path}.description`),
    imageUrl: nullableString(value.imageUrl, `${path}.imageUrl`),
    items: value.items.map((item, index) => parseListaItem(item, `${path}.items[${index}]`)),
  };
}

function validateCatalogReferences(catalog: CatalogItem[]): Set<string> {
  const categorySlugs = new Set<string>(CATEGORIES.map(({ slug }) => slug));
  const productIds = new Set<string>();
  for (const product of catalog) {
    if (productIds.has(product.id)) fail(`duplicate product id "${product.id}"`);
    productIds.add(product.id);
    if (!categorySlugs.has(product.category)) {
      fail(`product "${product.id}" has unknown category "${product.category}"`);
    }
  }
  return productIds;
}

function validateListReferences(listas: Lista[], productIds: Set<string>): void {
  const listIds = new Set<string>();
  for (const lista of listas) {
    if (listIds.has(lista.id)) fail(`duplicate list id "${lista.id}"`);
    listIds.add(lista.id);
    const seenInList = new Set<string>();
    for (const item of lista.items) {
      if (!productIds.has(item.id)) {
        fail(`list "${lista.id}" references missing product "${item.id}"`);
      }
      if (seenInList.has(item.id)) {
        fail(`list "${lista.id}" references product "${item.id}" more than once`);
      }
      seenInList.add(item.id);
    }
  }
}

function parseAndValidateSnapshots(): { catalog: CatalogItem[]; listas: Lista[] } {
  if (!Array.isArray(catalogSnapshot)) fail('catalog snapshot must be an array');
  if (!Array.isArray(listasSnapshot)) fail('listas snapshot must be an array');

  const catalog = catalogSnapshot.map((item, index) => parseCatalogItem(item, `catalog[${index}]`));
  const listas = listasSnapshot.map((lista, index) => parseLista(lista, `listas[${index}]`));

  if (catalog.length !== EXPECTED_PRODUCT_COUNT) {
    fail(`expected ${EXPECTED_PRODUCT_COUNT} products, got ${catalog.length}`);
  }
  if (listas.length !== EXPECTED_LIST_COUNT) {
    fail(`expected ${EXPECTED_LIST_COUNT} lists, got ${listas.length}`);
  }
  const listItemCount = listas.reduce((count, lista) => count + lista.items.length, 0);
  if (listItemCount !== EXPECTED_LIST_ITEM_COUNT) {
    fail(`expected ${EXPECTED_LIST_ITEM_COUNT} list items, got ${listItemCount}`);
  }

  validateListReferences(listas, validateCatalogReferences(catalog));

  return { catalog, listas };
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Parse before the first DDL statement. A corrupt immutable snapshot must
  // fail the migration without leaving a partially-created catalog schema.
  const { catalog, listas } = parseAndValidateSnapshots();

  await db.schema
    .createTable('catalogo_categorias')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('catalogo_categorias_position_nonnegative', sql`position >= 0`)
    .execute();

  await db.schema
    .createTable('catalogo_produtos')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_legado', 'text', (col) => col.unique())
    .addColumn('nome', 'text', (col) => col.notNull())
    .addColumn('preco_cents', 'bigint', (col) => col.notNull())
    .addColumn('quantidade_sugerida', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('emoji', 'text', (col) => col.notNull())
    .addColumn('bg_color', 'text', (col) => col.notNull())
    .addColumn('id_categoria', 'uuid', (col) => col.notNull())
    // Deviation from the approved spec's initial column list: the bundled
    // loader preserves source order within each category. Persist that order
    // so the DB-backed picker is a deterministic drop-in. Position is
    // intentionally not unique; reads use product UUID as the tie-break.
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('image_url', 'text')
    .addColumn('popularidade', 'integer')
    .addColumn('ativo', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('catalogo_produtos_preco_cents_positive', sql`preco_cents > 0`)
    .addCheckConstraint(
      'catalogo_produtos_quantidade_sugerida_positive',
      sql`quantidade_sugerida > 0`,
    )
    .addCheckConstraint('catalogo_produtos_position_nonnegative', sql`position >= 0`)
    .addForeignKeyConstraint(
      'catalogo_produtos_id_categoria_fk',
      ['id_categoria'],
      'catalogo_categorias',
      ['id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .execute();

  await db.schema
    .createIndex('catalogo_produtos_id_categoria_idx')
    .on('catalogo_produtos')
    .column('id_categoria')
    .execute();
  await db.schema
    .createIndex('catalogo_produtos_ativo_idx')
    .on('catalogo_produtos')
    .column('ativo')
    .execute();

  await db.schema
    .createTable('catalogo_listas')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('slug', 'text', (col) => col.unique())
    .addColumn('nome', 'text', (col) => col.notNull())
    .addColumn('descricao', 'text')
    .addColumn('image_url', 'text')
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('ativo', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('catalogo_listas_position_nonnegative', sql`position >= 0`)
    .execute();

  await db.schema
    .createTable('catalogo_lista_itens')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_lista', 'uuid', (col) => col.notNull())
    .addColumn('id_produto', 'uuid', (col) => col.notNull())
    .addColumn('quantidade', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('position', 'integer', (col) => col.notNull())
    .addCheckConstraint('catalogo_lista_itens_quantidade_positive', sql`quantidade > 0`)
    .addCheckConstraint('catalogo_lista_itens_position_nonnegative', sql`position >= 0`)
    .addForeignKeyConstraint(
      'catalogo_lista_itens_id_lista_fk',
      ['id_lista'],
      'catalogo_listas',
      ['id'],
      (constraint) => constraint.onDelete('cascade'),
    )
    .addForeignKeyConstraint(
      'catalogo_lista_itens_id_produto_fk',
      ['id_produto'],
      'catalogo_produtos',
      ['id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .addUniqueConstraint('catalogo_lista_itens_lista_produto_uniq', ['id_lista', 'id_produto'])
    .addUniqueConstraint('catalogo_lista_itens_lista_position_uniq', ['id_lista', 'position'])
    .execute();

  await db.schema
    .createIndex('catalogo_lista_itens_id_produto_idx')
    .on('catalogo_lista_itens')
    .column('id_produto')
    .execute();

  const now = new Date();
  const categoryIds = new Map<string, string>(CATEGORIES.map(({ slug }) => [slug, randomUUID()]));
  await db
    .insertInto('catalogo_categorias' as never)
    .values(
      CATEGORIES.map(({ slug, label }, position) => ({
        id: categoryIds.get(slug),
        slug,
        label,
        position,
        criado_em: now,
      })) as never,
    )
    .execute();

  const productIds = new Map(catalog.map(({ id }) => [id, randomUUID()]));
  const positionsByCategory = new Map<string, number>();
  await db
    .insertInto('catalogo_produtos' as never)
    .values(
      catalog.map((product) => {
        const position = positionsByCategory.get(product.category) ?? 0;
        positionsByCategory.set(product.category, position + 1);
        return {
          id: productIds.get(product.id),
          id_legado: product.id,
          nome: product.name,
          preco_cents: Math.round(product.price * 100),
          quantidade_sugerida: product.suggestedQty,
          emoji: product.emoji,
          bg_color: product.bgColor,
          id_categoria:
            categoryIds.get(product.category) ??
            fail(`missing generated category id for "${product.category}"`),
          position,
          image_url: product.imageUrl,
          popularidade: product.popularity ?? null,
          ativo: true,
          criado_em: now,
          atualizado_em: now,
        };
      }) as never,
    )
    .execute();

  const listIds = new Map(listas.map(({ id }) => [id, randomUUID()]));
  await db
    .insertInto('catalogo_listas' as never)
    .values(
      listas.map((lista, position) => ({
        id: listIds.get(lista.id),
        slug: lista.id,
        nome: lista.title,
        descricao: lista.description,
        image_url: lista.imageUrl,
        position,
        ativo: true,
        criado_em: now,
        atualizado_em: now,
      })) as never,
    )
    .execute();

  await db
    .insertInto('catalogo_lista_itens' as never)
    .values(
      listas.flatMap((lista) =>
        lista.items.map((item, position) => ({
          id: randomUUID(),
          id_lista: listIds.get(lista.id),
          id_produto: productIds.get(item.id),
          quantidade: item.suggestedQty,
          position,
        })),
      ) as never,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('catalogo_lista_itens').execute();
  await db.schema.dropTable('catalogo_listas').execute();
  await db.schema.dropTable('catalogo_produtos').execute();
  await db.schema.dropTable('catalogo_categorias').execute();
}
