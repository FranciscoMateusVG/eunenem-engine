/**
 * useMensagensAdmin — mock hooks for the admin mensagens slice
 * (aperture-5v766 Phase B).
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  TODO(aperture-5v766-rex-swap)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Each mock here mirrors a trpc react-query hook shape exactly (data /
 * isLoading / error / mutate / mutateAsync / isPending). When Rex's
 * backend (aperture-16wrk) lands and exposes `admin.mensagens.*` procs,
 * the swap is a one-line change per hook:
 *
 *   useMockMensagensList(idCampanha)
 *     → trpc.admin.mensagens.list.useQuery({ idCampanha })
 *
 *   useMockMarcarLida()
 *     → trpc.admin.mensagens.marcarLida.useMutation({
 *         onSuccess: () => utils.admin.mensagens.list.invalidate(),
 *       })
 *
 *   useMockMarcarTodasLidas()
 *     → trpc.admin.mensagens.marcarTodasLidas.useMutation({
 *         onSuccess: () => utils.admin.mensagens.list.invalidate(),
 *       })
 *
 * The consumer in `MensagensBody.tsx` destructures only the documented
 * fields below, so flipping these three hooks to real trpc is a
 * find-replace; no consumer-side type changes should be required if Rex's
 * AdminRecadoProjection matches our shared schema verbatim.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AdminMensagensList,
  AdminRecadoProjection,
} from '@/lib/schemas/admin-recado';

// ── In-memory fixture store ────────────────────────────────────────────
//
// Keyed by idCampanha so multiple campaign-slugs render distinct decks in
// dev. The "default" key seeds 5 recados with a realistic mix of read /
// unread + varied gift contexts. Mutations write back to this store so
// the page reflects state across re-renders within a session.

const NOW = Date.now();

const FIXTURE_STORE: Record<string, AdminRecadoProjection[]> = {};

function seedFixtures(): AdminRecadoProjection[] {
  return [
    {
      idPagamento: '11111111-1111-4111-8111-111111111111',
      contribuinteNome: 'tia rosângela',
      mensagem:
        'que alegria imensa te esperar, pequeno! a titia já está contando os dias pra encher você de beijos. ♡',
      criadoEm: new Date(NOW - 1000 * 60 * 60 * 4), // 4h ago
      valorContribuicao: 12000,
      contribuicaoNome: 'kit body recém-nascido',
      lidaEm: null,
    },
    {
      idPagamento: '22222222-2222-4222-8222-222222222222',
      contribuinteNome: 'vovó cleide',
      mensagem:
        'meu neto amado, a vovó preparou esse cantinho com todo amor do mundo. mal posso esperar pra te ninar.',
      criadoEm: new Date(NOW - 1000 * 60 * 60 * 26), // ~1 day ago
      valorContribuicao: 48000,
      contribuicaoNome: 'berço + enxoval',
      lidaEm: null,
    },
    {
      idPagamento: '33333333-3333-4333-8333-333333333333',
      contribuinteNome: 'carol e thiago',
      mensagem:
        'pra começar a vida com pé direito e muito conforto. estamos super felizes por vocês três! contem com a gente sempre. ♡',
      criadoEm: new Date(NOW - 1000 * 60 * 60 * 49), // ~2 days ago
      valorContribuicao: 65000,
      contribuicaoNome: 'carrinho de bebê',
      lidaEm: null,
    },
    {
      idPagamento: '44444444-4444-4444-8444-444444444444',
      contribuinteNome: 'madrinha ju',
      mensagem:
        'afilhado lindo, a dinda já te ama demais. esse é só o primeiro de muitos mimos, viu?',
      criadoEm: new Date(NOW - 1000 * 60 * 60 * 80), // ~3 days ago
      valorContribuicao: 9000,
      contribuicaoNome: 'mobile musical',
      lidaEm: new Date(NOW - 1000 * 60 * 60 * 70),
    },
    {
      idPagamento: '55555555-5555-4555-8555-555555555555',
      contribuinteNome: 'priscila do trabalho',
      mensagem:
        'helena, parabéns pela novidade mais linda! que ele venha com muita saúde. um beijo carinhoso da equipe toda.',
      criadoEm: new Date(NOW - 1000 * 60 * 60 * 120), // ~5 days ago
      valorContribuicao: 7500,
      contribuicaoNome: 'kit higiene',
      lidaEm: new Date(NOW - 1000 * 60 * 60 * 100),
    },
  ];
}

function getStore(idCampanha: string): AdminRecadoProjection[] {
  if (!FIXTURE_STORE[idCampanha]) {
    FIXTURE_STORE[idCampanha] = seedFixtures();
  }
  return FIXTURE_STORE[idCampanha]!;
}

function computeCounts(
  rows: readonly AdminRecadoProjection[],
): AdminMensagensList['counts'] {
  let naoLidas = 0;
  for (const r of rows) if (r.lidaEm === null) naoLidas += 1;
  return { todas: rows.length, naoLidas };
}

// ── Cross-hook subscription so mutations re-render queries ─────────────
//
// trpc's react-query does this via the query cache; here we fake it with
// a global tick counter. Each useMockMensagensList subscribes; mutations
// bump the tick to force a re-read of the fixture store.

const subscribers = new Set<() => void>();
function notify() {
  for (const fn of subscribers) fn();
}

// ── Hook 1: list query ─────────────────────────────────────────────────

export interface UseMockMensagensListResult {
  data: AdminMensagensList | undefined;
  isLoading: boolean;
  error: { message: string } | null;
}

/**
 * Mirror of `trpc.admin.mensagens.list.useQuery({ idCampanha })`.
 *
 * Returns `{ recados, counts: { todas, naoLidas } }` once the fake fetch
 * resolves (200ms timer to surface the loading skeleton in dev).
 */
export function useMockMensagensList(
  idCampanha: string,
): UseMockMensagensListResult {
  const [isLoading, setIsLoading] = useState(true);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => setIsLoading(false), 200);
    const sub = () => setTick((t) => t + 1);
    subscribers.add(sub);
    return () => {
      clearTimeout(id);
      subscribers.delete(sub);
    };
  }, [idCampanha]);

  const data = useMemo<AdminMensagensList | undefined>(() => {
    if (isLoading) return undefined;
    const recados = getStore(idCampanha);
    return { recados: [...recados], counts: computeCounts(recados) };
    // tick is read implicitly via setTick -> re-render; getStore reads fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, idCampanha]);

  return { data, isLoading, error: null };
}

// ── Hook 2: marcarLida mutation ────────────────────────────────────────

export interface UseMockMarcarLidaResult {
  mutate: (input: { idPagamento: string }) => void;
  mutateAsync: (input: { idPagamento: string }) => Promise<void>;
  isPending: boolean;
  error: { message: string } | null;
  data: { idPagamento: string; lidaEm: Date } | undefined;
}

/**
 * Mirror of `trpc.admin.mensagens.marcarLida.useMutation()`.
 *
 * Idempotent: re-marking an already-read recado is a no-op (and Rex's
 * backend will return the existing lidaEm timestamp — we mimic that here
 * by NOT overwriting a non-null lidaEm).
 */
export function useMockMarcarLida(idCampanha: string): UseMockMarcarLidaResult {
  const [isPending, setIsPending] = useState(false);
  const [data, setData] = useState<UseMockMarcarLidaResult['data']>(undefined);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const run = useCallback(
    async (input: { idPagamento: string }) => {
      setIsPending(true);
      await new Promise((r) => setTimeout(r, 120));
      const rows = getStore(idCampanha);
      const idx = rows.findIndex((r) => r.idPagamento === input.idPagamento);
      let lidaEm: Date;
      if (idx >= 0) {
        const row = rows[idx]!;
        lidaEm = row.lidaEm ?? new Date();
        rows[idx] = { ...row, lidaEm };
      } else {
        lidaEm = new Date();
      }
      notify();
      if (mountedRef.current) {
        setIsPending(false);
        setData({ idPagamento: input.idPagamento, lidaEm });
      }
    },
    [idCampanha],
  );

  return {
    mutate: (input) => void run(input),
    mutateAsync: run,
    isPending,
    error: null,
    data,
  };
}

// ── Hook 3: marcarTodasLidas mutation ──────────────────────────────────

export interface UseMockMarcarTodasLidasResult {
  mutate: (input: { idCampanha: string }) => void;
  mutateAsync: (input: { idCampanha: string }) => Promise<void>;
  isPending: boolean;
  error: { message: string } | null;
  data: { numMarcadas: number } | undefined;
}

/**
 * Mirror of `trpc.admin.mensagens.marcarTodasLidas.useMutation()`.
 *
 * Batch idempotent: only rows where lidaEm === null get a fresh timestamp.
 */
export function useMockMarcarTodasLidas(): UseMockMarcarTodasLidasResult {
  const [isPending, setIsPending] = useState(false);
  const [data, setData] =
    useState<UseMockMarcarTodasLidasResult['data']>(undefined);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const run = useCallback(async (input: { idCampanha: string }) => {
    setIsPending(true);
    await new Promise((r) => setTimeout(r, 160));
    const rows = getStore(input.idCampanha);
    let numMarcadas = 0;
    const now = new Date();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.lidaEm === null) {
        rows[i] = { ...row, lidaEm: now };
        numMarcadas += 1;
      }
    }
    notify();
    if (mountedRef.current) {
      setIsPending(false);
      setData({ numMarcadas });
    }
  }, []);

  return {
    mutate: (input) => void run(input),
    mutateAsync: run,
    isPending,
    error: null,
    data,
  };
}
