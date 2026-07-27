import { initTRPC } from "@trpc/server";
import { z } from "zod";
import type {
  CatalogoListaItemComProduto,
  CatalogoProdutoComCategoria,
} from "../../../../src/index.js";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

const PUBLIC_IMAGE_BASE = new URL("https://catalogo.eunenem.invalid");
const HTTP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isCatalogoImageUrl(value: string): boolean {
  // WHATWG URL parsing treats backslashes as slashes in special schemes.
  // Reject before parsing so `/\evil.example` cannot become `//evil.example`.
  if (value.includes("\\")) return false;

  if (value.startsWith("/")) {
    if (value.startsWith("//")) return false;
    const resolved = new URL(value, PUBLIC_IMAGE_BASE);
    return resolved.origin === PUBLIC_IMAGE_BASE.origin;
  }

  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && HTTP_LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export const CatalogoImageUrlPublicaSchema = z
  .string()
  .max(2_048)
  .refine(isCatalogoImageUrl)
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

function listaProntaItemPublico({ item, produto }: CatalogoListaItemComProduto) {
  return {
    id: produto.id,
    name: produto.nome,
    price: produto.precoCents / 100,
    // A ready-made list owns its quantity. The product default is only used
    // when composing a new list, never when projecting an existing one.
    suggestedQty: item.quantidade,
    emoji: produto.emoji,
    bgColor: CatalogoBgColorPublicoSchema.parse(produto.bgColor),
    imageUrl: produto.imageUrl,
  };
}

/**
 * Unauthenticated, read-only catalogue projection.
 *
 * The repository owns active-row filtering and deterministic position/UUID
 * ordering. This layer only groups and translates persistence records into
 * the stable public DTOs. Repository failures are intentionally not caught:
 * tRPC must surface them as INTERNAL_SERVER_ERROR rather than lying with an
 * empty catalogue.
 */
export const catalogoRouter = t.router({
  listSections: t.procedure
    .input(z.object({}).strict().optional())
    .output(CatalogoListSectionsOutputSchema)
    .query(async ({ ctx }) => {
      const produtos = await ctx.deps.catalogoRepository.findProdutosAtivosComCategoria();
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
        section.items.push(produtoPublico(produtoComCategoria));
        sections.set(categoria.id, section);
      }

      return [...sections.values()];
    }),

  listListasProntas: t.procedure
    .input(z.object({}).strict().optional())
    .output(CatalogoListasProntasOutputSchema)
    .query(async ({ ctx }) => {
      const listas = await ctx.deps.catalogoRepository.findListasAtivasComItensAtivos();
      const entries: [string, z.infer<typeof ListaProntaDetailPublicoSchema>][] = [];
      const keys = new Set<string>();

      for (const { lista, itens } of listas) {
        const key = lista.slug ?? lista.id;
        if (keys.has(key)) {
          throw new Error(`Chave pública duplicada em listas prontas: ${key}`);
        }
        keys.add(key);
        entries.push([
          key,
          {
            id: key,
            title: lista.nome,
            description: lista.descricao ?? "",
            imageUrl: lista.imageUrl,
            items: itens.map(listaProntaItemPublico),
          },
        ]);
      }

      return Object.fromEntries(entries);
    }),
});
