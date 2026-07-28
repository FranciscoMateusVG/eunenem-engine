import type { inferRouterOutputs } from "@trpc/server";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { formatBRL } from "@/lib/formatBRL.js";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../../../../../server/trpc/router.js";
import {
  AtivoBadge,
  type BgColorToken,
  BG_COLOR_TOKENS,
  centsToPriceInput,
  EmptyBlock,
  ErrorBlock,
  FieldLabel,
  GhostButton,
  LoadingBlock,
  ModalShell,
  parsePriceToCents,
  PrimaryButton,
  SelectField,
  SwatchSelect,
  TextField,
  useDebouncedValue,
} from "./catalogo-shared.js";
import { ImageUploadField } from "./ImageUploadField.js";

// Infer DTO shapes from the server contract so the tab tracks it
// automatically (no hand-maintained mirror to drift). Type-only import —
// erased at build, so it does not participate in ESM path resolution.
type RouterOutputs = inferRouterOutputs<AppRouter>;
type ProdutoDTO =
  RouterOutputs["admin"]["catalog"]["listProducts"]["products"][number];
type CategoriaDTO =
  RouterOutputs["admin"]["catalog"]["listCategories"][number];

const PAGE_SIZE = 20;

export function ProdutosTab() {
  const [searchRaw, setSearchRaw] = useState("");
  const search = useDebouncedValue(searchRaw.trim(), 300);
  const [idCategoria, setIdCategoria] = useState<string>("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ProdutoDTO | null>(null);
  const [creating, setCreating] = useState(false);

  const utils = trpc.useUtils();
  const categoriesQuery = trpc.admin.catalog.listCategories.useQuery();
  const productsQuery = trpc.admin.catalog.listProducts.useQuery(
    {
      search: search || undefined,
      idCategoria: idCategoria || undefined,
      includeInactive,
      page,
      pageSize: PAGE_SIZE,
    },
    { staleTime: 15_000 },
  );

  const setAtivo = trpc.admin.catalog.setProductAtivo.useMutation({
    onSuccess: () => {
      void utils.admin.catalog.listProducts.invalidate();
      void utils.admin.catalog.listCategories.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const categories = categoriesQuery.data ?? [];
  const categoryLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.label);
    return map;
  }, [categories]);

  // Reset to page 1 whenever a filter changes.
  function resetFilter(fn: () => void) {
    fn();
    setPage(1);
  }

  const products = productsQuery.data?.products ?? [];
  const total = productsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <FieldLabel htmlFor="produto-search">Buscar</FieldLabel>
          <input
            id="produto-search"
            type="search"
            value={searchRaw}
            onChange={(e) => resetFilter(() => setSearchRaw(e.target.value))}
            placeholder="nome do produto…"
            className="block w-full rounded-md border border-line bg-paper px-4 py-2 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
          />
        </div>
        <div className="min-w-[160px]">
          <FieldLabel htmlFor="produto-cat-filter">Categoria</FieldLabel>
          <SelectField
            id="produto-cat-filter"
            value={idCategoria}
            onChange={(v) => resetFilter(() => setIdCategoria(v))}
          >
            <option value="">todas</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </SelectField>
        </div>
        <label className="flex items-center gap-2 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) =>
              resetFilter(() => setIncludeInactive(e.target.checked))
            }
            className="size-4 rounded border-line text-plum focus:ring-lilac-soft"
          />
          incluir inativos
        </label>
        <div className="ml-auto">
          <PrimaryButton onClick={() => setCreating(true)}>
            + adicionar produto
          </PrimaryButton>
        </div>
      </div>

      {/* Data surface — error ≠ empty (surface-fetch-errors) */}
      {productsQuery.isLoading ? (
        <LoadingBlock />
      ) : productsQuery.error ? (
        <ErrorBlock
          message={productsQuery.error.message}
          onRetry={() => void productsQuery.refetch()}
        />
      ) : products.length === 0 ? (
        <EmptyBlock message="Nenhum produto encontrado." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-line bg-paper">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-cream-2/40">
                  <Th>produto</Th>
                  <Th>categoria</Th>
                  <Th align="right">preço</Th>
                  <Th align="right">sugerido</Th>
                  <Th align="right">popularidade</Th>
                  <Th>status</Th>
                  <Th align="right">ações</Th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-line transition-colors last:border-b-0 hover:bg-lilac-soft/30"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          style={{ backgroundColor: p.bgColor }}
                          className="flex size-7 items-center justify-center rounded-md border border-line text-[15px]"
                        >
                          {p.emoji}
                        </span>
                        <span className="text-[13px] text-ink">{p.nome}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-ink-soft">
                      {categoryLabel.get(p.idCategoria) ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink">
                      {formatBRL(p.precoCents)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-soft">
                      {p.quantidadeSugerida}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-soft">
                      {p.popularidade ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <AtivoBadge ativo={p.ativo} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <GhostButton onClick={() => setEditing(p)}>
                          editar
                        </GhostButton>
                        <GhostButton
                          onClick={() =>
                            setAtivo.mutate({ id: p.id, ativo: !p.ativo })
                          }
                          disabled={setAtivo.isPending}
                          danger={p.ativo}
                        >
                          {p.ativo ? "desativar" : "ativar"}
                        </GhostButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.1em] text-ink-mute">
            <span>
              {total} produto{total === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <GhostButton
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ‹ anterior
              </GhostButton>
              <span className="tabular-nums">
                {page} / {totalPages}
              </span>
              <GhostButton
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                próxima ›
              </GhostButton>
            </div>
          </div>
        </>
      )}

      {(creating || editing) && (
        <ProdutoFormModal
          produto={editing}
          categories={categories}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            void utils.admin.catalog.listProducts.invalidate();
            void utils.admin.catalog.listCategories.invalidate();
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={`px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

/* -----------------------------------------------------------------------
 * Product create/edit modal — zod-mirrored client validation, then
 * create/update mutation. On BAD_REQUEST/CONFLICT the server message is
 * surfaced (single source of truth for the catalog-owned image policy).
 * --------------------------------------------------------------------- */

interface FieldErrors {
  nome?: string;
  preco?: string;
  emoji?: string;
  idCategoria?: string;
  quantidadeSugerida?: string;
  popularidade?: string;
}

function ProdutoFormModal({
  produto,
  categories,
  onClose,
  onSaved,
}: {
  produto: ProdutoDTO | null;
  categories: CategoriaDTO[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = produto !== null;
  const [nome, setNome] = useState(produto?.nome ?? "");
  const [precoText, setPrecoText] = useState(
    produto ? centsToPriceInput(produto.precoCents) : "",
  );
  const [quantidadeSugerida, setQuantidadeSugerida] = useState(
    String(produto?.quantidadeSugerida ?? 1),
  );
  const [emoji, setEmoji] = useState(produto?.emoji ?? "🎁");
  const [bgColor, setBgColor] = useState<BgColorToken>(
    (produto?.bgColor as BgColorToken) ?? BG_COLOR_TOKENS[4],
  );
  const [idCategoria, setIdCategoria] = useState(
    produto?.idCategoria ?? categories[0]?.id ?? "",
  );
  const [imageUrl, setImageUrl] = useState<string | null>(
    produto?.imageUrl ?? null,
  );
  const [popularidade, setPopularidade] = useState(
    produto?.popularidade != null ? String(produto.popularidade) : "",
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  const utils = trpc.useUtils();
  const createMut = trpc.admin.catalog.createProduct.useMutation();
  const updateMut = trpc.admin.catalog.updateProduct.useMutation();
  const pending = createMut.isPending || updateMut.isPending;

  function validate(): {
    ok: boolean;
    precoCents: number;
    qtd: number;
    pop: number | null;
  } {
    const next: FieldErrors = {};
    const precoCents = parsePriceToCents(precoText);
    const qtd = Number(quantidadeSugerida);
    const popTrim = popularidade.trim();
    const pop = popTrim === "" ? null : Number(popTrim);

    if (nome.trim().length < 1 || nome.trim().length > 200)
      next.nome = "informe um nome (até 200 caracteres).";
    if (precoCents === null || precoCents < 1)
      next.preco = "informe um preço válido maior que zero.";
    if (emoji.trim().length < 1 || emoji.trim().length > 32)
      next.emoji = "escolha um emoji.";
    if (!idCategoria) next.idCategoria = "selecione uma categoria.";
    if (!Number.isInteger(qtd) || qtd < 1)
      next.quantidadeSugerida = "quantidade sugerida deve ser ≥ 1.";
    if (pop !== null && (!Number.isInteger(pop) || pop < 0))
      next.popularidade = "popularidade deve ser um inteiro ≥ 0.";

    setErrors(next);
    return {
      ok: Object.keys(next).length === 0,
      precoCents: precoCents ?? 0,
      qtd,
      pop,
    };
  }

  async function onSubmit() {
    const v = validate();
    if (!v.ok) return;
    try {
      if (isEdit && produto) {
        await updateMut.mutateAsync({
          id: produto.id,
          nome: nome.trim(),
          precoCents: v.precoCents,
          quantidadeSugerida: v.qtd,
          emoji: emoji.trim(),
          bgColor,
          idCategoria,
          imageUrl,
          popularidade: v.pop,
        });
        toast.success("produto atualizado.");
      } else {
        await createMut.mutateAsync({
          nome: nome.trim(),
          precoCents: v.precoCents,
          quantidadeSugerida: v.qtd,
          emoji: emoji.trim(),
          bgColor,
          idCategoria,
          imageUrl,
          popularidade: v.pop,
        });
        toast.success("produto criado.");
      }
      void utils.admin.catalog.listProducts.invalidate();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "não consegui salvar.");
    }
  }

  return (
    <ModalShell
      title={isEdit ? "editar produto" : "novo produto"}
      eyebrow="catálogo · produto"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={pending}>
            cancelar
          </GhostButton>
          <PrimaryButton onClick={onSubmit} disabled={pending}>
            {pending ? "salvando…" : "salvar"}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <FieldLabel htmlFor="pf-nome">Nome</FieldLabel>
          <TextField
            id="pf-nome"
            value={nome}
            onChange={setNome}
            placeholder="Fralda RN"
            maxLength={200}
            invalid={!!errors.nome}
          />
          {errors.nome && <FieldError>{errors.nome}</FieldError>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="pf-preco">Preço (R$)</FieldLabel>
            <TextField
              id="pf-preco"
              value={precoText}
              onChange={setPrecoText}
              placeholder="29,90"
              inputMode="decimal"
              invalid={!!errors.preco}
            />
            {errors.preco && <FieldError>{errors.preco}</FieldError>}
          </div>
          <div>
            <FieldLabel htmlFor="pf-qtd">Quantidade sugerida</FieldLabel>
            <TextField
              id="pf-qtd"
              value={quantidadeSugerida}
              onChange={setQuantidadeSugerida}
              inputMode="numeric"
              invalid={!!errors.quantidadeSugerida}
            />
            {errors.quantidadeSugerida && (
              <FieldError>{errors.quantidadeSugerida}</FieldError>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="pf-emoji">Emoji</FieldLabel>
            <TextField
              id="pf-emoji"
              value={emoji}
              onChange={setEmoji}
              maxLength={32}
              invalid={!!errors.emoji}
            />
            {errors.emoji && <FieldError>{errors.emoji}</FieldError>}
          </div>
          <div>
            <FieldLabel htmlFor="pf-cat">Categoria</FieldLabel>
            <SelectField
              id="pf-cat"
              value={idCategoria}
              onChange={setIdCategoria}
              invalid={!!errors.idCategoria}
            >
              <option value="" disabled>
                selecione…
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </SelectField>
            {errors.idCategoria && <FieldError>{errors.idCategoria}</FieldError>}
          </div>
        </div>

        <div>
          <FieldLabel>Cor de fundo</FieldLabel>
          <SwatchSelect value={bgColor} onChange={setBgColor} />
        </div>

        <div>
          <FieldLabel htmlFor="pf-pop">Popularidade (opcional)</FieldLabel>
          <TextField
            id="pf-pop"
            value={popularidade}
            onChange={setPopularidade}
            inputMode="numeric"
            placeholder="—"
            invalid={!!errors.popularidade}
          />
          {errors.popularidade && <FieldError>{errors.popularidade}</FieldError>}
        </div>

        <ImageUploadField value={imageUrl} onChange={setImageUrl} />
      </div>
    </ModalShell>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 font-mono text-[10px] tracking-[0.02em] text-red-700">
      {children}
    </p>
  );
}
