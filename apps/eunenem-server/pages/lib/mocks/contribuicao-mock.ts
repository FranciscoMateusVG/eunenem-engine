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
  /** Filled once a guest reserves the item. null = still available.
   *  DEPRECATED per plan 0015 Phase 1 — contribuinte data moves to
   *  IntencaoPagamento. Kept on the interface during the transition because
   *  visitorGift.ts + ContribuicoesList.tsx still read it; follow-up bead
   *  will retire it once those consumers have been migrated. */
  contribuinte: { nome: string; email: string } | null;
  /**
   * `indisponivel` once a contribuinte has reserved — server-side
   * mutations refuse to update locked rows (see `update` below).
   *
   * DEPRECATED per plan 0015 Phase 1 — replaced by the derived
   * `indisponivel: boolean` predicate below. Kept on the interface during
   * the transition because visitorGift.ts + ContribuicoesList.tsx still
   * read it; follow-up bead migrates those consumers.
   */
  status: "disponivel" | "indisponivel";
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

/** Single-item create. `qty` rows get inserted, each with its own id. */
export interface CreateInput {
  nome: string;
  /** Cents. */
  valor: number;
  imagemUrl?: string | null;
  grupo?: string | null;
  qty: number;
}

/** Bulk create — N items, each carrying its own qty multiplier. */
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
 * Materialize one CreateInput into `qty` separate ContribuicaoDTO rows.
 * Each row gets its own UUID — the qty multiplier lives at the store
 * boundary, never as a column on the row itself (a "qty: 8 of fraldas"
 * decomposes to 8 individual rows so per-unit reservation works).
 */
function expandCreateInput(input: CreateInput): ContribuicaoDTO[] {
  const rows: ContribuicaoDTO[] = [];
  for (let i = 0; i < input.qty; i++) {
    rows.push({
      id: crypto.randomUUID(),
      nome: input.nome,
      valor: input.valor,
      imagemUrl: input.imagemUrl ?? null,
      grupo: input.grupo ?? null,
      contribuinte: null,
      status: "disponivel",
    });
  }
  return rows;
}

// ── Procedures ─────────────────────────────────────────────────────────────

export const mockContribuicao = {
  /** Returns every contribuicao in insertion order. */
  async list(): Promise<ContribuicaoDTO[]> {
    await delay(200);
    return Array.from(STORE.values());
  },

  /**
   * Single-item create — routes through `createBulk` so the qty
   * multiplier path stays single-source.
   */
  async create(input: CreateInput): Promise<{ ids: string[] }> {
    return mockContribuicao.createBulk({ items: [input] });
  },

  /**
   * Bulk create — each input item produces `input.qty` rows.
   * 3 items each qty=2 → 6 rows; 1 item qty=8 → 8 rows.
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
   * Add `qty` units of a single catalog item. Optional `overrides`
   * patch the derived CreateInput before it's expanded — supports the
   * "I want this catalog item but rename it / bump the price" flow.
   */
  async createFromCatalog(input: {
    catalogItemId: string;
    qty: number;
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
      qty: input.qty,
    };
    const merged: CreateInput = { ...base, ...(input.overrides ?? {}) };
    return mockContribuicao.createBulk({ items: [merged] });
  },

  /**
   * Expand a "lista pronta" bundle into individual contribuicoes.
   * Every item in the bundle becomes its own CreateInput (qty per
   * item from `suggestedQty`), then a single createBulk call flushes
   * the lot.
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
      qty: it.suggestedQty,
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
