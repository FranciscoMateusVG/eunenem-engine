import { useState as useReactState } from "react";

/**
 * Repasses stub data layer — plan q2d4b Track 3 UI scaffold (aperture-vi0hy
 * parallel-prep against aperture-riywh).
 *
 * Rex's backend (Track 3 of aperture-q2d4b) is in flight; the @repo/domains
 * schema + tRPC procs haven't shipped yet. This module ships the manual
 * typedefs that mirror the LOCKED contract verbatim PLUS a deterministic
 * stub data layer keyed by djb2(idRepasse) so the UI renders convincingly
 * during scaffold review.
 *
 * SWAP PLAYBOOK (when Rex's PR lands):
 *   1. Replace the type imports here with `z.infer<typeof PagamentoRepassesAdminDTOSchema>` (or the equivalent shared schema).
 *   2. Replace `useStubRepassesList()` body with `trpc.admin.repasses.list.useQuery(...)`.
 *   3. Replace `useStubRepasseDetail(id)` body with `trpc.admin.repasses.show.useQuery({ idRepasse: id })`.
 *   4. Replace `useStubRepasseAprovar()` body with `trpc.admin.repasses.aprovar.useMutation()`.
 *   5. Delete this file's djb2 + DETERMINISTIC_SAMPLE blocks; keep the
 *      typedefs (or drop them in favor of inferred types from trpc).
 *
 * The UI components import ONLY the hooks + types from this module. They
 * have zero awareness that the data is stubbed. When Rex's PR lands and we
 * swap the hook bodies, the UI is untouched.
 *
 * LOCKED CONTRACT (from glados dispatch 2026-06-04):
 *
 *   admin.repasses.aprovar
 *     input  { idRepasse: UUID, bankTransferRef: string | null }
 *     output { repasse: RepasseRecebedor, lancamentosAfetados: number }
 *     errors 404 NOT_FOUND, 409 CONFLICT
 *
 *   admin.repasses.list
 *     output rows: idRepasse, idCampanha, campanhaTitulo, recebedorNome,
 *                  amountCents, numLancamentos, status, solicitadoEm,
 *                  aprovadoEm: nullable, bankTransferRef: nullable
 *
 *   admin.repasses.show
 *     output repasse + lancamentos[] (gift name + contribuinte name +
 *                                     amount + metodo)
 *
 *   RepasseStatus = 'solicitado' | 'aprovado' (2-state FSM per Locked
 *                                              Decision Q2(a); approval IS
 *                                              the journal entry, no
 *                                              `pago` / `cancelado` /
 *                                              `rejeitado` in v1)
 */

export type RepasseStatus = "solicitado" | "aprovado";

export type RepasseListRow = {
  idRepasse: string;
  idCampanha: string;
  campanhaTitulo: string;
  recebedorNome: string;
  amountCents: number;
  numLancamentos: number;
  status: RepasseStatus;
  solicitadoEm: string; // ISO
  aprovadoEm: string | null; // ISO; null while solicitado
  bankTransferRef: string | null;
};

/**
 * Lancamento breakdown row for the detail-page drill-down (matches Rex's
 * locked RepasseLancamentoDetail shape on `aperture-riywh-admin-repasses`).
 *
 * No `giftNome` / `metodo` on this projection — the lancamento carries only
 * its own + parent identifiers + amount + the contribuinte snapshot. Gift
 * name + metodo are reachable via drill (idContribuicao → contribuição /
 * idPagamento → pagamento) but Rex deliberately keeps this row lean to
 * avoid composing across 3 BCs at list time. v1 surfaces what's here; if
 * operator asks for gift name inline we re-spec a richer projection.
 */
export type RepasseDetailLancamento = {
  idLancamento: string;
  idPagamento: string;
  idContribuicao: string;
  amountCents: number;
  /** Snapshot from intencao.contribuinte at the time of the pagamento.
   * Null on anonymous-checkout rows OR pre-Phase-3 historical rows. */
  contribuinteNome: string | null;
  /** ISO timestamp — when the parent pagamento was created (criadoEm). */
  pagamentoCriadoEm: string;
};

/** Mutation result shape per Rex's locked contract. */
export type AprovarMutationResult = {
  idRepasse: string;
  aprovadoEm: string;
  numLancamentosTransferidos: number;
  totalCents: number;
};

export type RepasseDetail = RepasseListRow & {
  lancamentos: readonly RepasseDetailLancamento[];
};

/* -----------------------------------------------------------------------
 * djb2 + deterministic sample helpers
 *
 * djb2 is a non-cryptographic hash that produces stable 32-bit ints for
 * any string input. We seed all the per-id stub values with djb2(id) so
 * the same idRepasse always renders the same campanha title, amount,
 * recebedor, etc. Two side effects worth flagging during scaffold review:
 *   1. Visual review across page-loads is consistent — operator sees the
 *      same fixture data twice → easier QA.
 *   2. Different ids produce different visible fixtures → the operator
 *      perceives a real list of distinct repasses, not 5 clones.
 *
 * Once Rex's PR lands and the swap happens, this entire block goes away.
 * --------------------------------------------------------------------- */

function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

const CAMPANHA_TITULOS = [
  "Casamento Ana & João",
  "Chá de bebê Helena",
  "Aniversário de 15 anos Sofia",
  "Bodas de prata Maria & Carlos",
  "Lua de mel Bia & Renato",
  "Casamento Beatriz & Pedro",
];

const RECEBEDOR_NOMES = [
  "Ana Souza",
  "Maria Oliveira",
  "Sofia Lima",
  "Beatriz Santos",
  "Carla Ferreira",
  "Patrícia Andrade",
];

const CONTRIBUINTE_NOMES = [
  "João Mendes",
  "Lucas Costa",
  "Mariana Pires",
  "Rafael Tavares",
  "Camila Borges",
  null, // anonymous-checkout case
];

function pick<T>(arr: readonly T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length] as T;
}

/**
 * Deterministic list of 6 stub repasses — enough to populate both the
 * `solicitado` and `aprovado` filter views with believable counts. Visible
 * in scaffold review; gone once Rex's PR lands.
 */
const STUB_LIST: ReadonlyArray<RepasseListRow> = [
  buildStubRow("repasse-aa11bb22-0001", "solicitado"),
  buildStubRow("repasse-cc33dd44-0002", "solicitado"),
  buildStubRow("repasse-ee55ff66-0003", "solicitado"),
  buildStubRow("repasse-1122aabb-0004", "aprovado"),
  buildStubRow("repasse-3344ccdd-0005", "aprovado"),
  buildStubRow("repasse-5566eeff-0006", "aprovado"),
];

function buildStubRow(
  idRepasse: string,
  status: RepasseStatus,
): RepasseListRow {
  const seed = djb2(idRepasse);
  const solicitadoMs = Date.now() - (seed % 60) * 86400000;
  const aprovadoMs = solicitadoMs + (seed % 7) * 86400000;
  return {
    idRepasse,
    idCampanha: `campanha-${seed.toString(36).slice(0, 8)}`,
    campanhaTitulo: pick(CAMPANHA_TITULOS, seed),
    recebedorNome: pick(RECEBEDOR_NOMES, seed),
    amountCents: 5000 + (seed % 50000),
    numLancamentos: 2 + (seed % 7),
    status,
    solicitadoEm: new Date(solicitadoMs).toISOString(),
    aprovadoEm:
      status === "aprovado" ? new Date(aprovadoMs).toISOString() : null,
    bankTransferRef:
      status === "aprovado"
        ? `TED-${seed.toString(36).slice(0, 6).toUpperCase()}`
        : null,
  };
}

function buildStubDetail(idRepasse: string): RepasseDetail | null {
  const row = STUB_LIST.find((r) => r.idRepasse === idRepasse);
  if (!row) return null;
  const seed = djb2(idRepasse);
  const n = row.numLancamentos;
  // Generate `n` deterministic lancamentos. Amounts sum to ~amountCents
  // (give-or-take rounding); operator-perceptible total alignment.
  // Pagamento criadoEm timestamps spread backwards from solicitadoEm so
  // they read as plausible source events.
  const solicitadoMs = new Date(row.solicitadoEm).getTime();
  const lancamentos: RepasseDetailLancamento[] = [];
  let remaining = row.amountCents;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const share = isLast
      ? remaining
      : Math.floor(remaining / (n - i)) + (((seed >> i) & 0x3f) - 32);
    const amount = Math.max(50, share);
    remaining -= amount;
    const pagamentoOffsetMs = ((seed >> (i * 3)) % 30) * 86400000;
    lancamentos.push({
      idLancamento: `lanc-${idRepasse.slice(-8)}-${i.toString().padStart(2, "0")}`,
      idPagamento: `pag-${(seed + i * 17).toString(36).slice(0, 8)}`,
      idContribuicao: `contrib-${(seed + i * 31).toString(36).slice(0, 8)}`,
      contribuinteNome: pick(CONTRIBUINTE_NOMES, seed, i),
      amountCents: amount,
      pagamentoCriadoEm: new Date(
        solicitadoMs - pagamentoOffsetMs,
      ).toISOString(),
    });
  }
  return { ...row, lancamentos };
}

/* -----------------------------------------------------------------------
 * Stub hooks — UI-facing surface. These match the shape of
 * `@tanstack/react-query` / trpc hooks closely enough that the swap to
 * real trpc is a body-replacement (no consumer changes).
 * --------------------------------------------------------------------- */

export type RepassesListResult = {
  rows: readonly RepasseListRow[];
  isLoading: boolean;
  error: { message: string } | null;
};

export type RepasseDetailResult = {
  data: RepasseDetail | null;
  isLoading: boolean;
  error: { message: string } | null;
};

export type AprovarMutationState = {
  mutate: (input: {
    idRepasse: string;
    bankTransferRef: string | null;
  }) => void;
  isPending: boolean;
  error: { message: string } | null;
  /** Populated after a successful approval. The UI renders a success card
   * with these fields after the mutation resolves. */
  data: AprovarMutationResult | null;
};

/**
 * List view stub. Returns ALL rows; consumer filters by status client-side
 * (matches the eventual trpc shape — list returns the full set, the UI
 * filter chip controls visibility). Swap target: `trpc.admin.repasses.list.useQuery()`.
 */
export function useStubRepassesList(): RepassesListResult {
  return { rows: STUB_LIST, isLoading: false, error: null };
}

/**
 * Detail view stub. Mirrors trpc's `{ data, isLoading, error }` shape.
 * Swap target: `trpc.admin.repasses.show.useQuery({ idRepasse })`.
 */
export function useStubRepasseDetail(idRepasse: string): RepasseDetailResult {
  return {
    data: buildStubDetail(idRepasse),
    isLoading: false,
    error: null,
  };
}

/**
 * Aprovar mutation stub — React-hook-shaped wrapper that exposes a
 * mutate function + isPending + error + data fields, matching the eventual
 * trpc.useMutation shape so the swap is a body replacement.
 *
 * The stub uses local state so the success card can render fields from the
 * returned `data` after the mutation resolves. Real impl: replace this
 * function body with `trpc.admin.repasses.aprovar.useMutation({ onSuccess })`
 * and rely on the same field names.
 */
export function useStubRepasseAprovar(
  onSuccess: (result: AprovarMutationResult) => void,
): AprovarMutationState {
  const [isPending, setIsPending] = useReactState(false);
  const [error, setError] = useReactState<{ message: string } | null>(null);
  const [data, setData] = useReactState<AprovarMutationResult | null>(null);
  return {
    mutate: (input) => {
      setIsPending(true);
      setError(null);
      window.setTimeout(() => {
        setIsPending(false);
        const seed = djb2(input.idRepasse);
        const result: AprovarMutationResult = {
          idRepasse: input.idRepasse,
          aprovadoEm: new Date().toISOString(),
          numLancamentosTransferidos: 2 + (seed % 7),
          totalCents: 5000 + (seed % 50000),
        };
        setData(result);
        onSuccess(result);
      }, 600);
    },
    isPending,
    error,
    data,
  };
}

