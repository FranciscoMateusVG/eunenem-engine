// aperture-925nx — client-side view of the admin "usuários migrados" contract.
//
// SINGLE SEAM between the UI (AdminMigradosPage + MigradosTable) and Rex's
// server contract (aperture-4i05m, `admin.usuarios.legado.listPaginated`,
// PR #118). The UI never derives meaning: every label below is a verbatim
// rendering of a server-declared status, and the counts are rendered as the
// server declares them (no client-side math).

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

/**
 * Data hook — the one place the UI touches tRPC. Same options as the
 * AdminPage users list: 30s staleness, previous page kept visible while the
 * next one loads (no empty flash between pages / searches).
 */
export function useMigradosList(input: MigradosListInput): MigradosQueryState {
  const q = trpc.admin.usuarios.legado.listPaginated.useQuery(input, {
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  return {
    data: q.data,
    isFetching: q.isFetching,
    error: q.error ? { message: q.error.message } : null,
    refetch: () => void q.refetch(),
  };
}
