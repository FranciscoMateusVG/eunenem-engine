import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
  CatalogoListaItemComProduto,
  CatalogoProdutoComCategoria,
} from "../../../../src/index.js";
import type { ObjectStorage } from "../../../../src/adapters/storage/object-storage.js";
import { isCatalogImageUrlReadable } from "../lib/security/catalog-image-url.js";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

export const CatalogoImageUrlPublicaSchema = z
  .string()
  .min(1)
  .max(2_048)
  .nullable();

export const CatalogoBgColorPublicoSchema = z.enum([
  "var(--blue)",
  "var(--blue-soft)",
  "var(--cream-2)",
  "var(--lilac-soft)",
  "var(--pink-soft)",
  "var(--yellow-soft)",
]);

/**
 * Public catalogue wire contract.
 *
 * Category identifiers deliberately remain open strings. The catalogue is
 * database-driven now; reintroducing the legacy closed unions here would make
 * an operator-created category valid in Postgres but invalid over tRPC.
 */
export const CatalogoItemPublicoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  price: z.number().positive(),
  suggestedQty: z.number().int().positive(),
  emoji: z.string(),
  bgColor: CatalogoBgColorPublicoSchema,
  category: z.string(),
  imageUrl: CatalogoImageUrlPublicaSchema,
  popularity: z.number().int().nonnegative().optional(),
});

export const CatalogoSectionPublicaSchema = z.object({
  category: z.string(),
  label: z.string(),
  items: z.array(CatalogoItemPublicoSchema),
});

export const ListaProntaItemPublicoSchema = CatalogoItemPublicoSchema.omit({
  category: true,
  popularity: true,
});

export const ListaProntaDetailPublicoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  imageUrl: CatalogoImageUrlPublicaSchema,
  items: z.array(ListaProntaItemPublicoSchema),
});

export const CatalogoListSectionsOutputSchema = z.array(CatalogoSectionPublicaSchema);
export const CatalogoListasProntasOutputSchema = z.record(
  z.string(),
  ListaProntaDetailPublicoSchema,
);

function produtoPublico({ produto, categoria }: CatalogoProdutoComCategoria) {
  return {
    id: produto.id,
    name: produto.nome,
    price: produto.precoCents / 100,
    suggestedQty: produto.quantidadeSugerida,
    emoji: produto.emoji,
    bgColor: CatalogoBgColorPublicoSchema.parse(produto.bgColor),
    category: categoria.slug,
    imageUrl: produto.imageUrl,
    ...(produto.popularidade === null ? {} : { popularity: produto.popularidade }),
  };
}

function requireReadableImageUrl(
  imageUrl: string | null,
  objectStorage: ObjectStorage,
): string | null {
  if (
    imageUrl !== null &&
    !isCatalogImageUrlReadable(imageUrl, objectStorage)
  ) {
    throw new Error("catalog image URL violates the owned/legacy host policy");
  }
  return imageUrl;
}

function produtoPublicoSeguro(
  row: CatalogoProdutoComCategoria,
  objectStorage: ObjectStorage,
) {
  const dto = produtoPublico(row);
  return {
    ...dto,
    imageUrl: requireReadableImageUrl(dto.imageUrl, objectStorage),
  };
}

function listaProntaItemPublico(
  { item, produto }: CatalogoListaItemComProduto,
  objectStorage: ObjectStorage,
) {
  return {
    id: produto.id,
    name: produto.nome,
    price: produto.precoCents / 100,
    // A ready-made list owns its quantity. The product default is only used
    // when composing a new list, never when projecting an existing one.
    suggestedQty: item.quantidade,
    emoji: produto.emoji,
    bgColor: CatalogoBgColorPublicoSchema.parse(produto.bgColor),
    imageUrl: requireReadableImageUrl(produto.imageUrl, objectStorage),
  };
}

async function runPublicCatalogQuery<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Não foi possível carregar o catálogo.",
    });
  }
}

/**
 * Unauthenticated, read-only catalogue projection.
 *
 * The repository owns active-row filtering and deterministic position/UUID
 * ordering. This layer only groups and translates persistence records into
 * the stable public DTOs. Repository/projection failures become a generic
 * INTERNAL_SERVER_ERROR rather than leaking internals or lying with an empty
 * catalogue.
 */
export const catalogoRouter = t.router({
  listSections: t.procedure
    .input(z.object({}).strict().optional())
    .output(CatalogoListSectionsOutputSchema)
    .query(({ ctx }) =>
      runPublicCatalogQuery(async () => {
        const produtos =
          await ctx.deps.catalogoRepository.findProdutosAtivosComCategoria();
        const sections = new Map<
          string,
          {
            category: string;
            label: string;
            items: ReturnType<typeof produtoPublico>[];
          }
        >();

        for (const produtoComCategoria of produtos) {
          const { categoria } = produtoComCategoria;
          const section = sections.get(categoria.id) ?? {
            category: categoria.slug,
            label: categoria.label,
            items: [],
          };
          section.items.push(
            produtoPublicoSeguro(
              produtoComCategoria,
              ctx.deps.objectStorage,
            ),
          );
          sections.set(categoria.id, section);
        }

        return [...sections.values()];
      }),
    ),

  listListasProntas: t.procedure
    .input(z.object({}).strict().optional())
    .output(CatalogoListasProntasOutputSchema)
    .query(({ ctx }) =>
      runPublicCatalogQuery(async () => {
        const listas =
          await ctx.deps.catalogoRepository.findListasAtivasComItensAtivos();
        const entries: [
          string,
          z.infer<typeof ListaProntaDetailPublicoSchema>,
        ][] = [];
        const keys = new Set<string>();

        for (const { lista, itens } of listas) {
          const key = lista.slug ?? lista.id;
          if (keys.has(key)) {
            throw new Error(`duplicate public ready-list key: ${key}`);
          }
          keys.add(key);
          entries.push([
            key,
            {
              id: key,
              title: lista.nome,
              description: lista.descricao ?? "",
              imageUrl: requireReadableImageUrl(
                lista.imageUrl,
                ctx.deps.objectStorage,
              ),
              items: itens.map((item) =>
                listaProntaItemPublico(item, ctx.deps.objectStorage),
              ),
            },
          ]);
        }

        return Object.fromEntries(entries);
      }),
    ),
});
