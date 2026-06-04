import { useState as useReactState } from "react";

/**
 * Extrato stub data layer — plan q2d4b Track 4 (aperture-ekn90).
 *
 * Rex's Track 2 backend (aperture-7g5sx) ships shortly with these procs:
 *   - trpc.recebedor.extrato.summary({ idCampanha })       → ExtratoSummaryDTO
 *   - trpc.recebedor.extrato.list({ idCampanha, ... })     → { rows, nextCursor, hasMore }
 *   - trpc.recebedor.transferencia.solicitar({ idCampanha }) → { idRepasse, ... }
 *
 * This module ships:
 *   - Manual typedefs mirroring Rex's locked contract verbatim
 *   - djb2-seeded deterministic stub data so the visual review is convincing
 *   - Hook-shaped surface (useStubExtratoSummary / .List / .SolicitarTransferencia)
 *     that mirrors trpc.useQuery / useMutation field names exactly so the swap
 *     is a hook-body replacement, no consumer change.
 *
 * SWAP PLAYBOOK (when Rex's PR lands):
 *   1. Drop the local type aliases; import from his schema source.
 *   2. Replace `useStubExtratoSummary` body with
 *      `trpc.recebedor.extrato.summary.useQuery({ idCampanha })`.
 *   3. Replace `useStubExtratoList` body with
 *      `trpc.recebedor.extrato.list.useQuery({ idCampanha, statusFilters, cursor, limit })`.
 *   4. Replace `useStubSolicitarTransferencia` body with
 *      `trpc.recebedor.transferencia.solicitar.useMutation({ onSuccess, onError })`.
 *   5. Replace the slug→idCampanha resolution stub (currently djb2-derived)
 *      with a real campanha lookup — probably an existing trpc.painel.findCampanhaBySlug
 *      or equivalent.
 *   6. Delete the djb2 + SAMPLE blocks.
 *
 * Error mapping (per Rex's confirmation on the wire format):
 *   TRPCClientError carries { code, message } where:
 *     - code='CONFLICT', message='repasse_ja_pendente'                → button disabled
 *     - code='UNPROCESSABLE_CONTENT', message='saldo_disponivel_insuficiente' → button disabled
 *     - code='BAD_REQUEST', message=<validation string>               → generic error toast
 */

// ── Locked contract types (mirror Rex's exports) ────────────────────────────

export type ExtratoLiberacao =
  | "aguardando_liberacao"
  | "disponivel"
  | "transferido"
  | "cancelado";

export type ExtratoSummaryDTO = {
  totalRecebidoCents: number;
  resgatadoCents: number;
  saldoDisponivelCents: number;
  aguardandoLiberacaoCents: number;
  proximaTransfDate: string | null; // ISO
  totalPresentes: number;
  dateRangeStart: string | null; // ISO
  dateRangeEnd: string | null; // ISO
};

export type ExtratoRowDTO = {
  idLancamento: string;
  idPagamento: string;
  contribuinteNome: string | null;
  amountCents: number;
  liberacao: ExtratoLiberacao;
  /** ISO — parent pagamento.criadoEm. */
  timestamp: string;
  /** ISO — populated ONLY when liberacao === 'aguardando_liberacao' AND
   *  parent pagamento has balanceTransactionAvailableOn. Null in the orphan
   *  window between charge.succeeded and the dispatcher persist. */
  liberadoEm: string | null;
};

export type ExtratoListInput = {
  idCampanha: string;
  statusFilters?: ExtratoLiberacao[];
  cursor?: string | null;
  limit?: number;
};

export type ExtratoListResult = {
  rows: readonly ExtratoRowDTO[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type SolicitarTransferenciaResult = {
  idRepasse: string;
  amountCents: number;
  solicitadoEm: string;
  numLancamentos: number;
};

/** Domain-error discriminator carried on TRPCClientError.message. */
export type SolicitarTransferenciaErrorMessage =
  | "repasse_ja_pendente"
  | "saldo_disponivel_insuficiente"
  | string;

export type ExtratoSummaryResult = {
  data: ExtratoSummaryDTO | null;
  isLoading: boolean;
  error: { message: string } | null;
};

export type ExtratoListResultHook = {
  data: ExtratoListResult | null;
  isLoading: boolean;
  error: { message: string } | null;
};

export type SolicitarTransferenciaState = {
  mutate: () => void;
  isPending: boolean;
  data: SolicitarTransferenciaResult | null;
  error: { code: string; message: string } | null;
  reset: () => void;
};

// ── djb2 + sample helpers ───────────────────────────────────────────────────

function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

const CONTRIBUINTE_NOMES: ReadonlyArray<string | null> = [
  "Mariana Souza",
  "Camila Ribeiro",
  "Vovó Lurdes",
  "Patrícia Andrade",
  "Fernanda Lima",
  "Beatriz Oliveira",
  "Juliana Castro",
  "Renata Almeida",
  "Carolina Mendes",
  "Aline Pereira",
  null, // anonymous-checkout
  "Larissa Cardoso",
];

const LIBERACOES: ReadonlyArray<ExtratoLiberacao> = [
  "aguardando_liberacao",
  "disponivel",
  "transferido",
  "cancelado",
];

/**
 * Build a deterministic ExtratoRowDTO at index `i` for slug `seed`. Same
 * seed + index pair always produces the same row — useful for QA + scaffold
 * review (operator sees identical fixtures across page-loads).
 */
function buildStubRow(seed: number, i: number): ExtratoRowDTO {
  const liberacao = LIBERACOES[(seed + i) % LIBERACOES.length] as ExtratoLiberacao;
  const tsOffsetMs = ((seed >> (i % 8)) % 30) * 86400000 + i * 3600000;
  const tsMs = Date.now() - tsOffsetMs;
  const amount = 5000 + ((seed >> (i * 2)) % 50000);
  const contribuinte = CONTRIBUINTE_NOMES[(seed + i * 5) % CONTRIBUINTE_NOMES.length] as
    | string
    | null;
  const liberadoEm =
    liberacao === "aguardando_liberacao"
      ? new Date(tsMs + 7 * 86400000).toISOString()
      : null;
  return {
    idLancamento: `lanc-${seed.toString(36).slice(0, 6)}-${i.toString().padStart(2, "0")}`,
    idPagamento: `pag-${(seed + i * 17).toString(36).slice(0, 6)}`,
    contribuinteNome: contribuinte,
    amountCents: amount,
    liberacao,
    timestamp: new Date(tsMs).toISOString(),
    liberadoEm,
  };
}

function buildStubSummary(seed: number, rows: readonly ExtratoRowDTO[]): ExtratoSummaryDTO {
  const totalRecebido = rows.reduce(
    (acc, r) => (r.liberacao !== "cancelado" ? acc + r.amountCents : acc),
    0,
  );
  const resgatado = rows.reduce(
    (acc, r) => (r.liberacao === "transferido" ? acc + r.amountCents : acc),
    0,
  );
  const saldoDisp = rows.reduce(
    (acc, r) => (r.liberacao === "disponivel" ? acc + r.amountCents : acc),
    0,
  );
  const aguardando = rows.reduce(
    (acc, r) => (r.liberacao === "aguardando_liberacao" ? acc + r.amountCents : acc),
    0,
  );
  const aguardandoRows = rows.filter((r) => r.liberacao === "aguardando_liberacao");
  const proximaTransfDate =
    aguardandoRows.length === 0
      ? null
      : aguardandoRows
          .map((r) => r.liberadoEm)
          .filter((v): v is string => v !== null)
          .sort()[0] ?? null;
  const timestamps = rows.map((r) => r.timestamp).sort();
  return {
    totalRecebidoCents: totalRecebido,
    resgatadoCents: resgatado,
    saldoDisponivelCents: saldoDisp,
    aguardandoLiberacaoCents: aguardando,
    proximaTransfDate,
    totalPresentes: rows.filter((r) => r.liberacao !== "cancelado").length,
    dateRangeStart: timestamps[0] ?? null,
    dateRangeEnd: timestamps[timestamps.length - 1] ?? null,
    // seed is unused here; consumer-cache hint
    ...{ _seed: seed },
  } as ExtratoSummaryDTO;
}

// ── Hook-shaped surface ─────────────────────────────────────────────────────

export function useStubExtratoSummary(idCampanha: string): ExtratoSummaryResult {
  const seed = djb2(idCampanha);
  const rows: ExtratoRowDTO[] = [];
  for (let i = 0; i < 18; i++) rows.push(buildStubRow(seed, i));
  return {
    data: buildStubSummary(seed, rows),
    isLoading: false,
    error: null,
  };
}

export function useStubExtratoList(input: ExtratoListInput): ExtratoListResultHook {
  const seed = djb2(input.idCampanha);
  const all: ExtratoRowDTO[] = [];
  for (let i = 0; i < 18; i++) all.push(buildStubRow(seed, i));
  const filtered =
    input.statusFilters && input.statusFilters.length > 0
      ? all.filter((r) => input.statusFilters!.includes(r.liberacao))
      : all;
  // Sort DESC by timestamp + id ASC tiebreaker (matches Rex's cursor sort).
  filtered.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
    return a.idLancamento < b.idLancamento ? -1 : 1;
  });
  return {
    data: {
      rows: filtered,
      nextCursor: null,
      hasMore: false,
    },
    isLoading: false,
    error: null,
  };
}

export function useStubSolicitarTransferencia(opts: {
  onSuccess: (result: SolicitarTransferenciaResult) => void;
}): SolicitarTransferenciaState {
  const [isPending, setIsPending] = useReactState(false);
  const [data, setData] = useReactState<SolicitarTransferenciaResult | null>(null);
  const [error, setError] = useReactState<{ code: string; message: string } | null>(
    null,
  );
  return {
    mutate: () => {
      setIsPending(true);
      setError(null);
      window.setTimeout(() => {
        setIsPending(false);
        const result: SolicitarTransferenciaResult = {
          idRepasse: `repasse-${Date.now().toString(36).slice(-8)}`,
          amountCents: 50000,
          solicitadoEm: new Date().toISOString(),
          numLancamentos: 6,
        };
        setData(result);
        opts.onSuccess(result);
      }, 600);
    },
    isPending,
    data,
    error,
    reset: () => {
      setIsPending(false);
      setData(null);
      setError(null);
    },
  };
}

/**
 * Stub resolver — slug → idCampanha. djb2-derived placeholder so the parallel-
 * prep stub has a deterministic id without touching a real campanha lookup.
 *
 * SWAP TARGET: replace with the real campanha-by-slug lookup. Likely
 * something like `trpc.painel.findCampanhaBySlug.useQuery({ slug })` — or
 * whatever Rex's contract exposes for that resolution. Until then, the stub
 * lets the rest of the wire-up compile + render against a stable seed.
 */
export function useStubCampanhaIdForSlug(slug: string): {
  idCampanha: string | null;
  isLoading: boolean;
  error: { message: string } | null;
} {
  return {
    idCampanha: `stub-campanha-${djb2(slug).toString(36).slice(0, 8)}`,
    isLoading: false,
    error: null,
  };
}
