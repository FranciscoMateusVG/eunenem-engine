import { trpc } from "@/lib/trpc";
// Deep-leaf type import (zod-only, pg-free) — see BancariosBody.tsx (aperture-9abwt).
import type { AcaoCampanha } from "../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js";

export interface AcessoCampanhaUI {
  papel: "owner" | "membro" | null;
  /** True only once the server confirmed the action. Hides by default while loading. */
  pode: (acao: AcaoCampanha) => boolean;
  isLoading: boolean;
  /** Query failure — callers must show an error/retry, not a permission-less UI. */
  error: unknown;
  refetch: () => unknown;
}

/**
 * aperture-1z18g — the caller's effective actions on a campanha
 * (`campanhaMembros.meuAcesso`). UI-only convenience: every action is ALSO
 * enforced server-side; this just hides what the member can't do.
 */
export function useAcessoCampanha(idCampanha: string | null | undefined): AcessoCampanhaUI {
  const query = trpc.campanhaMembros.meuAcesso.useQuery(
    { idCampanha: idCampanha ?? "" },
    { enabled: typeof idCampanha === "string" && idCampanha.length > 0 },
  );
  const acoes = query.data?.acoes ?? [];
  return {
    papel: query.data?.papel ?? null,
    pode: (acao) => acoes.includes(acao),
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => query.refetch(),
  };
}
