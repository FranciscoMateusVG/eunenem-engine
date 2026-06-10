// aperture-0ph83 — in-memory mock for the contribuicao tRPC procedures
// Rex is shipping in PR #68 (aperture-d6atj). The shape here matches the
// LOCKED contract exactly so the adapter (`lib/contribuicao.ts`) can flip
// from this mock to the real `trpc.contribuicao.*` calls without any
// caller seeing the change.
//
// Behavior intentionally mirrors what the server-side procedures will
// promise: a 200ms artificial delay on every operation (so loading
// states render naturally), throws TRPCError shapes the adapter's error
// mapper already routes on, and persists state for the lifetime of the
// module evaluation (browser tab / SSR worker — whichever boundary the
// import lands in). Store starts EMPTY so the zero-state UI renders
// correctly on /painel/<slug>/lista.

import { TRPCError } from "@trpc/server";

import {
  loadCatalog,
  loadListasProntas,
  type ListaCatalogItem,
  type ListaProntaId,
} from "../../../lib/templates";

// ── Contract types (LOCKED — mirror Rex's d6atj router) ────────────────────

/** Single contribuicao row as exposed by `contribuicao.list`. */
export interface ContribuicaoDTO {
  id: string;
  nome: string;
  /** Unit price in cents — matches the engine's MoneyCents convention. */
  valor: number;
  /** Emoji glyph or future asset URL for the thumb. Nullable per spec. */
  imagemUrl: string | null;
  /** Category-ish grouping tag. Nullable for ad-hoc custom items. */
  grupo: string | null;
  /**
   * Plan 0016 (aperture-putz5): slot capacity. Pre-0016 every slot was
   * implicitly quantidade=1 and "5 wine glasses" meant 5 rows; post-0016
   * it's ONE row with quantidade=5 (locked decision #1). Optional during
   * the migration to keep the visitor wire (which doesn't yet project
   * quantidade) typecheck-clean; will tighten to required once the
   * visitor cart MVP (aperture-16flf) lands.
   */
  quantidade?: number;
  /**
   * Plan 0016 (aperture-ypk01): remaining unsold slots = `quantidade - sold`.
   * Optional during migration to keep mocks and any pre-bump consumers
   * typecheck-clean; required for the painel lista's "X de N recebidos"
   * tally to render correctly on partially-sold new-shape rows. Overshoot
   * is accepted per locked decision #10 — value can go negative; consumers
   * clamp at 0 for display. Mirrors visitor-side wire shape from PR #182.
   */
  quantidadeRestante?: number;
  /** Filled once a guest reserves the item. null = still available.
   *  DEPRECATED per plan 0015 Phase 1 — contribuinte data moves to
   *  IntencaoPagamento. The wire stopped projecting this field for
   *  pagina.obterListaPresentes after Phase 1; consumers must treat the
   *  absence as "no contribuinte yet" (the visitor view never needed
   *  this projection — it would be a PII leak across an unauthed
   *  surface). Optional here so other consumers (admin internal mocks)
   *  can still set it. */
  contribuinte?: { nome: string; email: string } | null;
  /**
   * `indisponivel` once a contribuinte has reserved — server-side
   * mutations refuse to update locked rows (see `update` below).
   *
   * DEPRECATED per plan 0015 Phase 1 — replaced by the derived
   * `indisponivel: boolean` predicate below. Optional here so the
   * visitor wire (which only returns `indisponivel`) typechecks; mocks
   * + admin consumers still set the legacy string when present.
   */
  status?: "disponivel" | "indisponivel";
  /**
   * Plan 0015 derived-availability predicate (aperture-ocw8r). Server-side
   * derived from `EXISTS pagamento WHERE id_contribuicao = X AND status =
   * 'aprovado'`. The lista-de-presentes (recebedor) + visitor marketplace
   * pages read this instead of comparing the legacy `status` string.
   *
   * PARALLEL-PREP STUB: OPTIONAL today because Rex's @repo/domains schema
   * commit for ContribuicaoListItem hasn't landed yet. When his PR opens,
   * drop the `?` modifier — single-line swap, no UI change. ListaPresentes
   * Body's group-by-nome accumulation reads `c.indisponivel === true` so
   * `undefined` is treated as not-yet-received (same as today's bug; bug
   * resolves the moment the wire starts populating the field).
   */
  indisponivel?: boolean;
}

/** Single-item create — ONE row with `quantidade=N` per Plan 0016. */
export interface CreateInput {
  nome: string;
  /** Cents. */
  valor: number;
  imagemUrl?: string | null;
  grupo?: string | null;
  /**
   * Plan 0016 (aperture-putz5): slot capacity. Replaces the pre-0016
   * `qty` row-multiplier shape — see `ContribuicaoDTO.quantidade`.
   */
  quantidade: number;
}

/** Bulk create — N items, each a single slot with its own `quantidade`. */
export interface BulkCreateInput {
  items: CreateInput[];
}

/** Partial update on a single contribuicao. */
export interface UpdateInput {
  id: string;
  nome?: string;
  valor?: number;
  imagemUrl?: string | null;
  grupo?: string | null;
  /**
   * Plan 0016 (aperture-putz5): change a slot's capacity. Per locked
   * decision #10 lowering below sold count is accepted (overshoot).
   */
  quantidade?: number;
}

/** Bulk delete by id list. Missing ids are silently ignored. */
export interface DeleteInput {
  ids: string[];
}

// ── Mock store ─────────────────────────────────────────────────────────────
//
// Module-level Map so every import resolves to the same backing store
// inside a single module evaluation. Deliberately EMPTY by default —
// zero-state is part of the UI contract.

const STORE: Map<string, ContribuicaoDTO> = new Map();

/** Simulates the wire latency the real tRPC procedures will incur. */
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Flat catalog-id → item lookup. Built once at module evaluation. */
const CATALOG_INDEX: Map<string, ListaCatalogItem> = (() => {
  const idx = new Map<string, ListaCatalogItem>();
  for (const section of loadCatalog()) {
    for (const item of section.items) {
      idx.set(item.id, item);
    }
  }
  return idx;
})();

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Materialize one CreateInput into ONE ContribuicaoDTO row carrying
 * `quantidade=N` (Plan 0016 aperture-putz5). Pre-0016 this loop emitted
 * N copies of the row; locked decision #1 retires that shape.
 */
function expandCreateInput(input: CreateInput): ContribuicaoDTO[] {
  return [
    {
      id: crypto.randomUUID(),
      nome: input.nome,
      valor: input.valor,
      imagemUrl: input.imagemUrl ?? null,
      grupo: input.grupo ?? null,
      quantidade: input.quantidade,
      contribuinte: null,
      status: "disponivel",
    },
  ];
}

// ── Procedures ─────────────────────────────────────────────────────────────

export const mockContribuicao = {
  /** Returns every contribuicao in insertion order. */
  async list(): Promise<ContribuicaoDTO[]> {
    await delay(200);
    return Array.from(STORE.values());
  },

  /**
   * Single-item create — routes through `createBulk` so the single-row
   * path stays single-source.
   */
  async create(input: CreateInput): Promise<{ ids: string[] }> {
    return mockContribuicao.createBulk({ items: [input] });
  },

  /**
   * Bulk create — each input item produces ONE row with `quantidade=N`
   * (Plan 0016 single-row + quantidade). 3 items each quantidade=2 →
   * 3 rows; 1 item quantidade=8 → 1 row.
   */
  async createBulk(input: BulkCreateInput): Promise<{ ids: string[] }> {
    await delay(200);
    const ids: string[] = [];
    for (const item of input.items) {
      for (const row of expandCreateInput(item)) {
        STORE.set(row.id, row);
        ids.push(row.id);
      }
    }
    return { ids };
  },

  /**
   * Add ONE slot of a single catalog item with `quantidade=N` (Plan
   * 0016). Optional `overrides` patch the derived CreateInput before
   * persistence — supports the "I want this catalog item but rename it /
   * bump the price" flow.
   */
  async createFromCatalog(input: {
    catalogItemId: string;
    quantidade: number;
    overrides?: Partial<CreateInput>;
  }): Promise<{ ids: string[] }> {
    const item = CATALOG_INDEX.get(input.catalogItemId);
    if (!item) {
      // Match the wire-level error shape the real procedure will throw —
      // surfaced via the adapter's `toContribuicaoError` as 'not-found'.
      await delay(200);
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Item do catalogo nao encontrado",
      });
    }
    const base: CreateInput = {
      nome: item.name,
      valor: Math.round(item.price * 100),
      imagemUrl: item.emoji,
      grupo: item.category,
      quantidade: input.quantidade,
    };
    const merged: CreateInput = { ...base, ...(input.overrides ?? {}) };
    return mockContribuicao.createBulk({ items: [merged] });
  },

  /**
   * Expand a "lista pronta" bundle into ONE row per bundle item, each
   * carrying its `suggestedQty` as `quantidade`. Pre-0016 a "suggestedQty:
   * 3" item produced 3 rows; post-0016 it's 1 row with quantidade=3.
   */
  async createFromListaPronta(input: {
    listaProntaId: string;
  }): Promise<{ ids: string[] }> {
    const presets = loadListasProntas();
    const bundle = presets[input.listaProntaId as ListaProntaId];
    if (!bundle) {
      await delay(200);
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Lista pronta nao encontrada",
      });
    }
    const items: CreateInput[] = bundle.items.map((it) => ({
      nome: it.name,
      valor: Math.round(it.price * 100),
      imagemUrl: it.emoji,
      // Bundle id IS the grupo — keeps the UI's category badge wired
      // even when the bundle isn't a strict ListaCategory value.
      grupo: bundle.id,
      quantidade: it.suggestedQty,
    }));
    return mockContribuicao.createBulk({ items });
  },

  /**
   * Patch an existing contribuicao. Locked rows (status =
   * `indisponivel`) reject with the literal message
   * `contribuicao_locked` so the adapter can switch on `.message`.
   */
  async update(input: UpdateInput): Promise<{ id: string }> {
    await delay(200);
    const existing = STORE.get(input.id);
    if (!existing) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Contribuicao nao encontrada",
      });
    }
    if (existing.status === "indisponivel") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "contribuicao_locked",
      });
    }
    const patched: ContribuicaoDTO = {
      ...existing,
      ...(input.nome !== undefined ? { nome: input.nome } : {}),
      ...(input.valor !== undefined ? { valor: input.valor } : {}),
      ...(input.imagemUrl !== undefined ? { imagemUrl: input.imagemUrl } : {}),
      ...(input.grupo !== undefined ? { grupo: input.grupo } : {}),
    };
    STORE.set(input.id, patched);
    return { id: input.id };
  },

  /**
   * Bulk delete. Ids that don't exist are silently skipped — the
   * server-side procedure does the same (idempotent delete).
   */
  async delete(input: DeleteInput): Promise<{ count: number }> {
    await delay(200);
    let count = 0;
    for (const id of input.ids) {
      if (STORE.delete(id)) count++;
    }
    return { count };
  },
};

/**
 * Test-only helper — clears the in-memory store between specs. Not
 * called from production code; exported so unit tests don't have to
 * reach into a private module-level Map.
 */
export function _resetMockStore(): void {
  STORE.clear();
}
