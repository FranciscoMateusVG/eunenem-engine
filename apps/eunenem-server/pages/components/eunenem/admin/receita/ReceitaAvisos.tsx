import { formatBRL } from "@/lib/formatBRL";
import { formatInstante, type ReceitaDashboard, ROTULOS } from "./types";

/**
 * Avisos da aba Receita EuNeném (aperture-9bpre).
 *
 * `LimitesDaFonte` é FIXO e sempre visível: diz o que o ledger não sabe, para
 * que nenhum número desta tela seja lido como mais do que é. Os demais avisos
 * só aparecem quando há o que mostrar — e mostram a diferença como ela é.
 */

export function LimitesDaFonte({
  primeiroRegistroTaxaEm,
  snapshotAt,
}: Pick<ReceitaDashboard, "primeiroRegistroTaxaEm" | "snapshotAt">) {
  return (
    <aside
      aria-labelledby="receita-limites-title"
      className="rounded-md border border-amber-200 bg-amber-50 p-4 text-[13px] leading-relaxed text-amber-900"
    >
      <h2 id="receita-limites-title" className="font-semibold">
        O que esta tela não mostra
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          Estorno parcial e contestação de cartão não alteram o ledger. Não estão refletidos aqui e
          nenhum valor é estimado para eles.
        </li>
        <li>
          O custo cobrado pelo provedor e o valor que chegou à conta bancária não são registrados.
          Não é possível dizer quanto sobra depois desses custos.
        </li>
        <li>
          Taxa cujo pagamento não pôde ser ligado a uma campanha desta plataforma não é contada. A
          cobertura dessas linhas é inconclusiva — não é zero.
        </li>
        <li>
          Um intervalo encerrado não muda por causa de um cancelamento posterior: o cancelamento
          entra na data em que ocorreu. Correções históricas ainda podem alterar intervalos
          passados.
        </li>
        <li>
          {primeiroRegistroTaxaEm
            ? `Primeiro registro de taxa no ledger: ${formatInstante(primeiroRegistroTaxaEm)}.`
            : "Ainda não há registro de taxa no ledger."}{" "}
          Isso indica onde os dados começam; não prova que todo pagamento antigo tem taxa
          registrada.
        </li>
      </ul>
      <p className="mt-3 font-mono text-[11px] text-amber-900/80">
        Leitura única de {formatInstante(snapshotAt)} (horário de São Paulo).
      </p>
    </aside>
  );
}

type Diferencas = ReceitaDashboard["conciliacao"]["diferencas"];

const ORIGENS: ReadonlyArray<{ chave: keyof Diferencas; rotulo: string }> = [
  { chave: "serie", rotulo: "soma da série" },
  { chave: "porCampanha", rotulo: "soma por campanha" },
  { chave: "porMeioProvedor", rotulo: "soma por meio e provedor" },
];

/** Só renderiza quando alguma soma difere do total independente. */
export function ConciliacaoAviso({ conciliacao }: Pick<ReceitaDashboard, "conciliacao">) {
  const divergentes = ORIGENS.filter(({ chave }) => {
    const d = conciliacao.diferencas[chave];
    return d.taxasRegistradasCents !== 0 || d.cancelamentosCents !== 0;
  });
  if (divergentes.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-[13px] text-red-800"
    >
      <p className="font-semibold">Diferença não conciliada</p>
      <p className="mt-1">
        O total do período ({ROTULOS.registradas.toLowerCase()}{" "}
        {formatBRL(conciliacao.totalIndependente.taxasRegistradasCents)},{" "}
        {ROTULOS.cancelamentos.toLowerCase()}{" "}
        {formatBRL(conciliacao.totalIndependente.cancelamentosCents)}) não bate com:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {divergentes.map(({ chave, rotulo }) => (
          <li key={chave}>
            {rotulo}: diferença de{" "}
            {formatBRL(conciliacao.diferencas[chave].taxasRegistradasCents)} em taxas registradas e{" "}
            {formatBRL(conciliacao.diferencas[chave].cancelamentosCents)} em cancelamentos
          </li>
        ))}
      </ul>
      <p className="mt-2">Nenhum valor foi ajustado. Requer conferência.</p>
    </div>
  );
}

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
