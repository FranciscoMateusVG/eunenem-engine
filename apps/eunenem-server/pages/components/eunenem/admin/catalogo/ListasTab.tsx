import type { inferRouterOutputs } from "@trpc/server";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatBRL } from "@/lib/formatBRL.js";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../../../../../server/trpc/router.js";
import {
  AtivoBadge,
  EmptyBlock,
  ErrorBlock,
  FieldLabel,
  GhostButton,
  LoadingBlock,
  ModalShell,
  PrimaryButton,
  TextField,
  useDebouncedValue,
} from "./catalogo-shared.js";
import { ImageUploadField } from "./ImageUploadField.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ListaDTO = RouterOutputs["admin"]["catalog"]["listLists"][number];

export function ListasTab() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingMeta, setEditingMeta] = useState<ListaDTO | null>(null);
  const [managingItems, setManagingItems] = useState<ListaDTO | null>(null);

  const utils = trpc.useUtils();
  const listsQuery = trpc.admin.catalog.listLists.useQuery({ includeInactive });

  const setAtivo = trpc.admin.catalog.setListAtivo.useMutation({
    onSuccess: () => void utils.admin.catalog.listLists.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  function invalidate() {
    void utils.admin.catalog.listLists.invalidate();
  }

  const lists = listsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="size-4 rounded border-line text-plum focus:ring-lilac-soft"
          />
          incluir inativas
        </label>
        <PrimaryButton onClick={() => setCreating(true)}>
          + adicionar lista
        </PrimaryButton>
      </div>

      {listsQuery.isLoading ? (
        <LoadingBlock />
      ) : listsQuery.error ? (
        <ErrorBlock
          message={listsQuery.error.message}
          onRetry={() => void listsQuery.refetch()}
        />
      ) : lists.length === 0 ? (
        <EmptyBlock message="Nenhuma lista pronta cadastrada." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {lists.map((l) => (
            <div
              key={l.id}
              className="flex gap-3 rounded-md border border-line bg-paper p-3"
            >
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-cream-2/40">
                {l.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.imageUrl}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
                    sem img
                  </span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-[14px] font-medium text-ink">
                    {l.nome}
                  </h3>
                  <AtivoBadge ativo={l.ativo} />
                </div>
                {l.descricao && (
                  <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-soft">
                    {l.descricao}
                  </p>
                )}
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                  {l.quantidadeItens} {l.quantidadeItens === 1 ? "item" : "itens"}
                </p>
                <div className="mt-auto flex flex-wrap justify-end gap-2 pt-2">
                  <GhostButton onClick={() => setManagingItems(l)}>
                    itens
                  </GhostButton>
                  <GhostButton onClick={() => setEditingMeta(l)}>
                    editar
                  </GhostButton>
                  <GhostButton
                    onClick={() => setAtivo.mutate({ id: l.id, ativo: !l.ativo })}
                    disabled={setAtivo.isPending}
                    danger={l.ativo}
                  >
                    {l.ativo ? "desativar" : "ativar"}
                  </GhostButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editingMeta) && (
        <ListaMetadataModal
          lista={editingMeta}
          onClose={() => {
            setCreating(false);
            setEditingMeta(null);
          }}
          onSaved={() => {
            invalidate();
            setCreating(false);
            setEditingMeta(null);
          }}
        />
      )}

      {managingItems && (
        <ListaItensModal
          lista={managingItems}
          onClose={() => setManagingItems(null)}
          onSaved={() => {
            invalidate();
            setManagingItems(null);
          }}
        />
      )}
    </div>
  );
}

/* -----------------------------------------------------------------------
 * List metadata create/edit — nome / descricao / imageUrl.
 * --------------------------------------------------------------------- */

function ListaMetadataModal({
  lista,
  onClose,
  onSaved,
}: {
  lista: ListaDTO | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = lista !== null;
  const [nome, setNome] = useState(lista?.nome ?? "");
  const [descricao, setDescricao] = useState(lista?.descricao ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(lista?.imageUrl ?? null);
  const [nomeError, setNomeError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const createMut = trpc.admin.catalog.createList.useMutation();
  const updateMut = trpc.admin.catalog.updateList.useMutation();
  const pending = createMut.isPending || updateMut.isPending;

  async function onSubmit() {
    const trimmed = nome.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      setNomeError("informe um nome (até 200 caracteres).");
      return;
    }
    setNomeError(null);
    const descTrim = descricao.trim();
    try {
      if (isEdit && lista) {
        await updateMut.mutateAsync({
          id: lista.id,
          nome: trimmed,
          descricao: descTrim === "" ? null : descTrim,
          imageUrl,
        });
        toast.success("lista atualizada.");
      } else {
        await createMut.mutateAsync({
          nome: trimmed,
          descricao: descTrim === "" ? null : descTrim,
          imageUrl,
        });
        toast.success("lista criada — adicione itens em seguida.");
      }
      void utils.admin.catalog.listLists.invalidate();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "não consegui salvar.");
    }
  }

  return (
    <ModalShell
      title={isEdit ? "editar lista" : "nova lista"}
      eyebrow="catálogo · lista pronta"
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
          <FieldLabel htmlFor="lf-nome">Nome</FieldLabel>
          <TextField
            id="lf-nome"
            value={nome}
            onChange={setNome}
            placeholder="Enxoval básico"
            maxLength={200}
            invalid={!!nomeError}
          />
          {nomeError && (
            <p className="mt-1 font-mono text-[10px] text-red-700">{nomeError}</p>
          )}
        </div>
        <div>
          <FieldLabel htmlFor="lf-desc">Descrição (opcional)</FieldLabel>
          <textarea
            id="lf-desc"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Uma seleção prática para as primeiras semanas."
            className="block w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
          />
        </div>
        <ImageUploadField value={imageUrl} onChange={setImageUrl} />
      </div>
    </ModalShell>
  );
}

/* -----------------------------------------------------------------------
 * List item manager — pick products (from the public catalog projection)
 * and set per-item quantities, then persist the whole set via setListItems.
 * The public listSections is a single query that already carries product
 * name/emoji/price, so the picker + the selected-items review both resolve
 * without extra fetches. getList seeds the working set with current items.
 * --------------------------------------------------------------------- */

type PublicItem = RouterOutputs["catalogo"]["listSections"][number]["items"][number];

function ListaItensModal({
  lista,
  onClose,
  onSaved,
}: {
  lista: ListaDTO;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [searchRaw, setSearchRaw] = useState("");
  const search = useDebouncedValue(searchRaw.trim().toLowerCase(), 200);
  const [category, setCategory] = useState<string>("");
  // working set: productId -> quantidade
  const [items, setItems] = useState<Map<string, number>>(new Map());
  const [seeded, setSeeded] = useState(false);

  const utils = trpc.useUtils();
  const sectionsQuery = trpc.catalogo.listSections.useQuery();
  const detailQuery = trpc.admin.catalog.getList.useQuery({ id: lista.id });
  const saveMut = trpc.admin.catalog.setListItems.useMutation();

  // Seed the working set once getList resolves (effect, not render-phase).
  const detailItems = detailQuery.data?.items;
  useEffect(() => {
    if (seeded || !detailItems) return;
    const initial = new Map<string, number>();
    for (const it of detailItems) initial.set(it.idProduto, it.quantidade);
    setItems(initial);
    setSeeded(true);
  }, [seeded, detailItems]);

  // Flatten the public sections into a product lookup + a category list.
  const { products, productMap, categories } = useMemo(() => {
    const sections = sectionsQuery.data ?? [];
    const flat: PublicItem[] = [];
    const map = new Map<string, PublicItem>();
    const cats: { slug: string; label: string }[] = [];
    for (const s of sections) {
      cats.push({ slug: s.category, label: s.label });
      for (const it of s.items) {
        flat.push(it);
        map.set(it.id, it);
      }
    }
    return { products: flat, productMap: map, categories: cats };
  }, [sectionsQuery.data]);

  const visible = useMemo(() => {
    return products.filter((p) => {
      if (category && p.category !== category) return false;
      if (search && !p.name.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [products, category, search]);

  function setQty(id: string, qty: number) {
    setItems((prev) => {
      const next = new Map(prev);
      if (qty <= 0) next.delete(id);
      else next.set(id, qty);
      return next;
    });
  }

  async function onSave() {
    // Unique, contiguous positions via array index (setListItems rejects
    // duplicate idProduto OR duplicate position with BAD_REQUEST).
    const payload = [...items.entries()].map(([idProduto, quantidade], i) => ({
      idProduto,
      quantidade,
      position: i,
    }));
    try {
      await saveMut.mutateAsync({ idLista: lista.id, items: payload });
      void utils.admin.catalog.listLists.invalidate();
      void utils.admin.catalog.getList.invalidate({ id: lista.id });
      toast.success("itens da lista salvos.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "não consegui salvar os itens.");
    }
  }

  const isLoading = sectionsQuery.isLoading || detailQuery.isLoading;
  const error = sectionsQuery.error ?? detailQuery.error;

  return (
    <ModalShell
      title={`itens · ${lista.nome}`}
      eyebrow="catálogo · lista pronta"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto font-mono text-[11px] uppercase tracking-[0.1em] text-ink-mute">
            {items.size} {items.size === 1 ? "item" : "itens"} selecionado
            {items.size === 1 ? "" : "s"}
          </span>
          <GhostButton onClick={onClose} disabled={saveMut.isPending}>
            cancelar
          </GhostButton>
          <PrimaryButton onClick={onSave} disabled={saveMut.isPending || isLoading}>
            {saveMut.isPending ? "salvando…" : "salvar itens"}
          </PrimaryButton>
        </>
      }
    >
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error.message} />
      ) : (
        <div className="space-y-3">
          {/* selected review */}
          {items.size > 0 && (
            <div className="rounded-md border border-line bg-cream-2/30 p-2">
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
                selecionados
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...items.entries()].map(([id, qty]) => {
                  const p = productMap.get(id);
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                    >
                      <span>{p ? `${p.emoji} ${p.name}` : "produto"}</span>
                      <span className="tabular-nums text-ink">×{qty}</span>
                      <button
                        type="button"
                        aria-label="remover"
                        onClick={() => setQty(id, 0)}
                        className="text-ink-mute transition-colors hover:text-red-700"
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* filters */}
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              value={searchRaw}
              onChange={(e) => setSearchRaw(e.target.value)}
              placeholder="buscar produto…"
              className="min-w-[180px] flex-1 rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-[12px] text-ink focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
            >
              <option value="">todas categorias</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* product grid */}
          {visible.length === 0 ? (
            <EmptyBlock message="Nenhum produto encontrado." />
          ) : (
            <ul className="max-h-[40vh] space-y-1 overflow-y-auto pr-1">
              {visible.map((p) => {
                const qty = items.get(p.id) ?? 0;
                const selected = qty > 0;
                return (
                  <li
                    key={p.id}
                    className={[
                      "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors",
                      selected
                        ? "border-plum/40 bg-lilac-soft/20"
                        : "border-line bg-paper hover:bg-lilac-soft/10",
                    ].join(" ")}
                  >
                    <span
                      aria-hidden
                      style={{ backgroundColor: p.bgColor }}
                      className="flex size-7 items-center justify-center rounded-md border border-line text-[15px]"
                    >
                      {p.emoji}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">{p.name}</p>
                      <p className="font-mono text-[11px] tabular-nums text-ink-mute">
                        {formatBRL(Math.round(p.price * 100))}
                      </p>
                    </div>
                    {selected ? (
                      <div className="flex items-center gap-1">
                        <QtyBtn onClick={() => setQty(p.id, qty - 1)}>−</QtyBtn>
                        <span className="w-6 text-center font-mono text-[13px] tabular-nums text-ink">
                          {qty}
                        </span>
                        <QtyBtn onClick={() => setQty(p.id, qty + 1)}>+</QtyBtn>
                      </div>
                    ) : (
                      <GhostButton onClick={() => setQty(p.id, p.suggestedQty || 1)}>
                        adicionar
                      </GhostButton>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </ModalShell>
  );
}

function QtyBtn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded border border-line bg-paper font-mono text-[13px] text-ink-soft transition-colors hover:border-plum hover:text-plum"
    >
      {children}
    </button>
  );
}
