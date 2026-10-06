import { formatBRL } from "@/lib/formatBRL";
import type { ReceitaDashboard } from "./types";

/**
 * Aviso de inconsistências do dashboard (aperture-9bpre), usado pela prévia
 * da NFS-e. A aba Receita 1b tem o próprio aviso compacto (ReceitaPainel).
 */

/** Só renderiza quando há linha incoerente no período. Fica fora dos totais. */
export function InconsistenciasAviso({
  inconsistencias,
}: Pick<ReceitaDashboard, "inconsistencias">) {
  const { estornadoSemCancelamento, canceladoSemEstorno } = inconsistencias;
  if (estornadoSemCancelamento.count === 0 && canceladoSemEstorno.count === 0) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900"
    >
      <p className="font-semibold">Linhas incoerentes no período</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {estornadoSemCancelamento.count > 0 ? (
          <li>
            {estornadoSemCancelamento.count} taxa(s) de pagamento estornado sem data de
            cancelamento — {formatBRL(estornadoSemCancelamento.cents)}. Continuam em taxas
            registradas e não aparecem em cancelamentos.
          </li>
        ) : null}
        {canceladoSemEstorno.count > 0 ? (
          <li>
            {canceladoSemEstorno.count} taxa(s) cancelada(s) cujo pagamento não está estornado —{" "}
            {formatBRL(canceladoSemEstorno.cents)}. Contam como cancelamento na data registrada.
          </li>
        ) : null}
      </ul>
      <p className="mt-2">Mostradas à parte. Nenhum total foi ajustado por causa delas.</p>
    </div>
  );
}
