import type { inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../../../../../server/trpc/router.js";
import {
  EmptyBlock,
  ErrorBlock,
  FieldLabel,
  GhostButton,
  LoadingBlock,
  ModalShell,
  PrimaryButton,
  TextField,
} from "./catalogo-shared.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CategoriaDTO =
  RouterOutputs["admin"]["catalog"]["listCategories"][number];

export function CategoriasTab() {
  const [editing, setEditing] = useState<CategoriaDTO | null>(null);
  const [creating, setCreating] = useState(false);

  const utils = trpc.useUtils();
  const categoriesQuery = trpc.admin.catalog.listCategories.useQuery();

  const deleteMut = trpc.admin.catalog.deleteCategory.useMutation({
    onSuccess: () => {
      void utils.admin.catalog.listCategories.invalidate();
      toast.success("categoria excluída.");
    },
    onError: (e) => toast.error(e.message),
  });

  function invalidateAll() {
    void utils.admin.catalog.listCategories.invalidate();
    void utils.admin.catalog.listProducts.invalidate();
  }

  const categories = categoriesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <PrimaryButton onClick={() => setCreating(true)}>
          + adicionar categoria
        </PrimaryButton>
      </div>

      {categoriesQuery.isLoading ? (
        <LoadingBlock />
      ) : categoriesQuery.error ? (
        <ErrorBlock
          message={categoriesQuery.error.message}
          onRetry={() => void categoriesQuery.refetch()}
        />
      ) : categories.length === 0 ? (
        <EmptyBlock message="Nenhuma categoria cadastrada." />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-paper">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-cream-2/40">
                <Th>slug</Th>
                <Th>rótulo</Th>
                <Th align="right">posição</Th>
                <Th align="right">produtos</Th>
                <Th align="right">ações</Th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => {
                const hasProducts = c.quantidadeProdutos > 0;
                return (
                  <tr
                    key={c.id}
                    className="border-b border-line transition-colors last:border-b-0 hover:bg-lilac-soft/30"
                  >
                    <td className="px-4 py-3 font-mono text-[12px] text-ink-soft">
                      {c.slug}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink">
                      {c.label}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-soft">
                      {c.position}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-soft">
                      {c.quantidadeProdutos}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <GhostButton onClick={() => setEditing(c)}>
                          editar
                        </GhostButton>
                        <span
                          title={
                            hasProducts
                              ? "categoria com produtos não pode ser excluída — mova ou remova os produtos primeiro."
                              : undefined
                          }
                        >
                          <GhostButton
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Excluir a categoria "${c.label}"?`,
                                )
                              ) {
                                deleteMut.mutate({ id: c.id });
                              }
                            }}
                            disabled={hasProducts || deleteMut.isPending}
                            danger
                          >
                            excluir
                          </GhostButton>
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <CategoriaFormModal
          categoria={editing}
          existing={categories}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            invalidateAll();
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

interface CatFieldErrors {
  slug?: string;
  label?: string;
  position?: string;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function CategoriaFormModal({
  categoria,
  existing,
  onClose,
  onSaved,
}: {
  categoria: CategoriaDTO | null;
  existing: CategoriaDTO[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = categoria !== null;
  const [slug, setSlug] = useState(categoria?.slug ?? "");
  const [label, setLabel] = useState(categoria?.label ?? "");
  const [position, setPosition] = useState(
    String(categoria?.position ?? existing.length),
  );
  const [errors, setErrors] = useState<CatFieldErrors>({});

  const utils = trpc.useUtils();
  const createMut = trpc.admin.catalog.createCategory.useMutation();
  const updateMut = trpc.admin.catalog.updateCategory.useMutation();
  const pending = createMut.isPending || updateMut.isPending;

  function validate(): { ok: boolean; pos: number } {
    const next: CatFieldErrors = {};
    const pos = Number(position);
    // slug is immutable after creation — only validate on create.
    if (!isEdit) {
      const s = slug.trim();
      if (!SLUG_RE.test(s))
        next.slug = "use apenas minúsculas, números e hífens (ex.: chá-de-fralda → cha-de-fralda).";
      else if (s === "personalizado")
        next.slug = "'personalizado' é reservado.";
      else if (s.length > 80) next.slug = "slug muito longo (máx 80).";
    }
    if (label.trim().length < 1 || label.trim().length > 120)
      next.label = "informe um rótulo (até 120 caracteres).";
    if (!Number.isInteger(pos) || pos < 0)
      next.position = "posição deve ser um inteiro ≥ 0.";
    setErrors(next);
    return { ok: Object.keys(next).length === 0, pos };
  }

  async function onSubmit() {
    const v = validate();
    if (!v.ok) return;
    try {
      if (isEdit && categoria) {
        await updateMut.mutateAsync({
          id: categoria.id,
          label: label.trim(),
          position: v.pos,
        });
        toast.success("categoria atualizada.");
      } else {
        await createMut.mutateAsync({
          slug: slug.trim(),
          label: label.trim(),
          position: v.pos,
        });
        toast.success("categoria criada.");
      }
      void utils.admin.catalog.listCategories.invalidate();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "não consegui salvar.");
    }
  }

  return (
    <ModalShell
      title={isEdit ? "editar categoria" : "nova categoria"}
      eyebrow="catálogo · categoria"
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
          <FieldLabel htmlFor="cf-slug">Slug</FieldLabel>
          <TextField
            id="cf-slug"
            value={slug}
            onChange={(v) => setSlug(v.toLowerCase())}
            placeholder="cha-de-fralda"
            maxLength={80}
            invalid={!!errors.slug}
          />
          {isEdit ? (
            <p className="mt-1 font-mono text-[10px] tracking-[0.02em] text-ink-mute">
              o slug não pode ser alterado após a criação.
            </p>
          ) : errors.slug ? (
            <FieldError>{errors.slug}</FieldError>
          ) : (
            <p className="mt-1 font-mono text-[10px] tracking-[0.02em] text-ink-mute">
              identificador estável, usado no catálogo do cliente.
            </p>
          )}
        </div>
        <div>
          <FieldLabel htmlFor="cf-label">Rótulo</FieldLabel>
          <TextField
            id="cf-label"
            value={label}
            onChange={setLabel}
            placeholder="Chá de fralda"
            maxLength={120}
            invalid={!!errors.label}
          />
          {errors.label && <FieldError>{errors.label}</FieldError>}
        </div>
        <div>
          <FieldLabel htmlFor="cf-pos">Posição</FieldLabel>
          <TextField
            id="cf-pos"
            value={position}
            onChange={setPosition}
            inputMode="numeric"
            invalid={!!errors.position}
          />
          {errors.position && <FieldError>{errors.position}</FieldError>}
        </div>
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
