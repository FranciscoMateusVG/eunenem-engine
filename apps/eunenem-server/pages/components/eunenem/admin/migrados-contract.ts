// aperture-925nx — client-side view of the admin "usuários migrados" contract.
//
// SINGLE SEAM between the UI (AdminMigradosPage + MigradosTable) and Rex's
// server contract (aperture-4i05m, `admin.usuarios.legado.listPaginated`,
// PR #118). The UI never derives meaning: every label below is a verbatim
// rendering of a server-declared status, and the counts are rendered as the
// server declares them (no client-side math).

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

/** One row = one legacy (1.0) person, deduped by normalized email on the server. */
export type MigradoRow = {
  /** Normalized email — the identity the legacy snapshot and 2.0 share. */
  email: string;
  /**
   * 2.0 domain display name (usuarios.nome_exibicao) when the server
   * resolved a coherent profile; null otherwise. NEVER a legacy campaign
   * title — that is a list name, not the person's name.
   */
  nomeExibicao: string | null;
  /**
   * 2.0 conta id ONLY when the server resolved a real account for this
   * email. Drives the /admin/usuario/:idConta link — no id, no link.
   */
  idConta: string | null;
  /** Number of legacy (1.0) campaigns listed for this email. */
  legacyCampaignCount: number;
  /** Server-declared status; rendered via MIGRADO_STATUS (see below). */
  status: MigradoStatus;
  /** ISO timestamp evidencing the status, or null when not evidenced. */
  evidencedAt: string | null;
};

/**
 * Status enum — VERBATIM mirror of Rex's root-approved 4i05m contract
 * (`admin.usuarios.legado.listPaginated`). Labels are the root-approved
 * operator wording; glosses restate the server's own definition of each
 * value. No value means "migrated": no durable fact links a legacy campaign
 * to a 2.0 campaign, so the UI never claims it.
 */
export type MigradoStatus =
  | "somente_legado"
  | "conta_2_0"
  | "perfil_2_0"
  | "evidencia_inconsistente";

export const MIGRADO_STATUS: Record<
  MigradoStatus,
  { label: string; gloss: string; tone: "mute" | "lilac" | "green" | "warn" }
> = {
  somente_legado: {
    label: "Só no legado",
    gloss:
      "consta no snapshot do EuNeném 1.0 e não há conta nem perfil 2.0 com este e-mail; sem data (o snapshot não tem horário)",
    tone: "mute",
  },
  conta_2_0: {
    label: "Conta 2.0 criada",
    gloss:
      "existe exatamente uma conta de login 2.0 com este e-mail, ainda sem perfil/conta de domínio; data = criação da conta de login",
    tone: "lilac",
  },
  perfil_2_0: {
    label: "Perfil 2.0 criado",
    gloss:
      "conta de login + usuário + conta de domínio coerentes no 2.0; data = criação da conta de domínio. Não prova migração das listas antigas",
    tone: "green",
  },
  evidencia_inconsistente: {
    label: "Dados inconsistentes",
    gloss:
      "e-mail duplicado/ambíguo ou cadeia 2.0 parcial/divergente; o servidor não arrisca nome, conta nem data",
    tone: "warn",
  },
};

export type MigradosListInput = {
  /** Matches name OR email prefix; trimmed; empty → no filter. */
  query?: string;
  cursor: string | null;
  limit: number;
};

export type MigradosListResult = {
  items: MigradoRow[];
  nextCursor: string | null;
  /** Exact total for the current filter. */
  totalCount: number;
  /** Server-declared counts per status — after the query filter, before the page. */
  counts: Partial<Record<MigradoStatus, number>>;
};

export type MigradosQueryState = {
  data: MigradosListResult | undefined;
  isFetching: boolean;
  error: { message: string } | null;
  refetch: () => void;
};

/** Trimmed search → contract input (mirrors adminUsersSearchInput). */
export function migradosSearchInput(query: string): Pick<MigradosListInput, "query"> {
  return { query: query.trim() || undefined };
}

/* -----------------------------------------------------------------------
 * Fetch state — pure, node-testable (aperture-925nx, Cipher HOLD follow-up)
 *
 * The procedure is a tRPC MUTATION (native POST — the cursor/filters never
 * ride a GET URL), so React Query's query cache does not manage it. The hook
 * below re-creates the two behaviours the page relies on:
 *   1. previous page stays visible while the next request is in flight
 *      (no empty flash between pages / keystrokes);
 *   2. a stale or out-of-order response NEVER replaces a newer one — every
 *      request takes a ticket, and only the latest ticket may commit.
 * --------------------------------------------------------------------- */

export type FetchState = {
  data: MigradosListResult | undefined;
  isFetching: boolean;
  error: { message: string } | null;
  /** Ticket of the most recently STARTED request. */
  latest: number;
};

export const INITIAL_FETCH_STATE: FetchState = {
  data: undefined,
  isFetching: true,
  error: null,
  latest: 0,
};

/** A new request starts: take the next ticket, keep previous data on screen. */
export function beginFetch(state: FetchState): { state: FetchState; ticket: number } {
  const ticket = state.latest + 1;
  return { state: { ...state, isFetching: true, error: null, latest: ticket }, ticket };
}

/** A response lands. Only the LATEST ticket may commit; older ones are dropped. */
export function settleFetch(
  state: FetchState,
  ticket: number,
  outcome: { ok: true; data: MigradosListResult } | { ok: false; message: string },
): FetchState {
  if (ticket !== state.latest) return state; // stale / out-of-order → ignored
  return outcome.ok
    ? { ...state, data: outcome.data, error: null, isFetching: false }
    : { ...state, error: { message: outcome.message }, isFetching: false };
}

/** Stable identity for an input so effects re-run only when the request changes. */
export function requestKey(input: MigradosListInput): string {
  return JSON.stringify([input.query ?? "", input.cursor, input.limit]);
}

/**
 * Data hook — the one place the UI touches tRPC. Mutation-backed (POST);
 * same public contract as before (data / isFetching / error / refetch), same
 * previous-page retention, plus the ticket guard above.
 */
export function useMigradosList(input: MigradosListInput): MigradosQueryState {
  const mutation = trpc.admin.usuarios.legado.listPaginated.useMutation();
  const [state, setState] = useState<FetchState>(INITIAL_FETCH_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mutateAsync = mutation.mutateAsync;
  // The effect keys on the REQUEST identity (query/cursor/limit), not on the
  // input object reference — AdminMigradosPage memoises it, but a re-created
  // object with equal fields must not refetch.
  const key = requestKey(input);
  const inputRef = useRef(input);
  inputRef.current = input;

  const run = useCallback(async () => {
    const begun = beginFetch(stateRef.current);
    stateRef.current = begun.state;
    setState(begun.state);
    let outcome:
      | { ok: true; data: MigradosListResult }
      | { ok: false; message: string };
    try {
      outcome = { ok: true, data: await mutateAsync(inputRef.current) };
    } catch (err) {
      outcome = {
        ok: false,
        message: err instanceof Error ? err.message : "não consegui carregar a lista",
      };
    }
    const settled = settleFetch(stateRef.current, begun.ticket, outcome);
    if (settled !== stateRef.current) {
      stateRef.current = settled;
      setState(settled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mutateAsync]);

  useEffect(() => {
    void run();
  }, [run]);

  return {
    data: state.data,
    isFetching: state.isFetching,
    error: state.error,
    refetch: () => void run(),
  };
}
