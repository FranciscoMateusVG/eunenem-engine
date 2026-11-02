import type { ReactNode } from "react";
import { REPASSE_STATUS_LABEL } from "../repasse-status";
import { CoberturaNota } from "./CoberturaNota";
import { dinheiro, numero } from "./formato";
import type { FinanceiroData } from "./types";

/**
 * Seção Financeiro (aperture-lcug3), sobre `admin.analytics.financeiro`.
 *
 * Margem de contribuição por lista, prazo de repasse e exposição a MED e
 * estornos. As categorias de exposição podem se sobrepor: cada uma aparece
 * numa linha própria e NUNCA somamos um total.
 */

type Faixa = FinanceiroData["repasses"]["aging"][number]["faixa"];
const FAIXAS: ReadonlyArray<{ key: Faixa; label: string }> = [
  { key: "0_2d", label: "0–2 dias" },
  { key: "3_7d", label: "3–7 dias" },
  { key: "8_30d", label: "8–30 dias" },
  { key: "mais_30d", label: "Mais de 30 dias" },
];

const TH = "py-2 pl-3 text-right font-normal";
const THEAD = "border-b border-line text-left font-mono text-[11px] uppercase text-ink-mute";

/** Horas como "18 h" ou, a partir de 2 dias, "3,5 dias". */
export function textoHoras(h: number | null): string {
  if (h === null) return "—";
  return h < 48 ? `${numero(h)} h` : `${numero(Math.round((h / 24) * 10) / 10)} dias`;
}

const rotuloEstado = (estado: string) =>
  (REPASSE_STATUS_LABEL as Record<string, string>)[estado] ?? estado;

function Bloco({ titulo, explicacao, children }: { titulo: string; explicacao: string; children: ReactNode }) {
  return (
    <section aria-label={titulo} className="flex min-w-0 flex-col gap-4 rounded-lg border border-line px-4 pb-4 pt-5 sm:px-6">
      <div>
        <h2 className="text-[16px] font-semibold tracking-normal! text-ink">{titulo}</h2>
        <p className="mt-1 text-sm text-ink-soft">{explicacao}</p>
      </div>
      {children}
    </section>
  );
}

function Kpi({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe: string }) {
  return (
    <div data-testid="financeiro-kpi" className="rounded-xl border border-line p-4">
      <div className="text-sm text-ink-soft">{rotulo}</div>
      <div className="text-2xl font-semibold tabular-nums">{valor}</div>
      <div className="font-mono text-[11px] text-ink-mute">{detalhe}</div>
    </div>
  );
}

const cents = (v: number | null) => (v === null ? "—" : dinheiro(v));

export function FinanceiroSecao({ data }: { data: FinanceiroData }) {
  const m = data.margem;
  const r = data.repasses;
  const e = data.exposicao;
  const estados = [...new Set(r.aging.map((a) => a.estado))];
  const exposicao: ReadonlyArray<{ rotulo: string; valor: number | null; explicacao: string }> = [
    { rotulo: "MED bloqueado", valor: e.medBloqueadoCents, explicacao: "valor travado pelo banco em contestações abertas" },
    { rotulo: "MED liberado", valor: e.medLiberadoCents, explicacao: "contestações encerradas a favor do recebedor" },
    { rotulo: "MED devolvido", valor: e.medDevolvidoCents, explicacao: "devolvido ao pagador por MED" },
    { rotulo: "Estornos Stripe confirmados", valor: e.estornosStripeConfirmadosCents, explicacao: "devolvidos ao pagador no cartão" },
    { rotulo: "Devoluções PIX confirmadas", valor: e.devolucoesPixConfirmadasCents, explicacao: "devolvidas ao pagador por PIX" },
    {
      rotulo: "Já repassado em pagamentos contestados",
      valor: e.jaRepassadoEmPagamentosContestadosCents,
      explicacao: "total transferido desses pagamentos, não perda líquida",
    },
    { rotulo: "Recuperado pela plataforma", valor: e.recuperadoPelaPlataformaCents, explicacao: "não medido: não existe registro de recuperação" },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Bloco
        titulo="Margem de contribuição por lista"
        explicacao="Tarifas EuNeném menos reversões e custos de provedor dos pagamentos aprovados no período. Sem custos fixos: não é lucro líquido."
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi rotulo="Tarifas EuNeném" valor={dinheiro(m.taxasCents)} detalhe={`${numero(m.pagamentos)} pagamentos`} />
          <Kpi rotulo="Reversões" valor={dinheiro(m.reversoesCents)} detalhe="tarifas canceladas" />
          <Kpi rotulo="Custos de provedor" valor={dinheiro(m.custosCents)} detalhe={`${numero(m.pagamentosComCusto)} pagamentos com custo`} />
          <Kpi rotulo="Margem de contribuição" valor={dinheiro(m.margemContribuicaoCents)} detalhe={`${numero(m.listas)} listas com venda`} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Kpi rotulo="p25 por lista" valor={cents(m.p25Cents)} detalhe="margem" />
          <Kpi rotulo="Mediana por lista" valor={cents(m.p50Cents)} detalhe="margem" />
          <Kpi rotulo="p90 por lista" valor={cents(m.p90Cents)} detalhe="margem" />
        </div>
        <CoberturaNota cobertura={m.cobertura} unidade="pagamentos" />
      </Bloco>

      <Bloco
        titulo="Prazo de repasse"
        explicacao="Tempo entre o pedido (ou a aprovação) do repasse e a transferência, e repasses ainda abertos por idade."
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi rotulo="Pedido → transferência" valor={textoHoras(r.solicitadoAteTransferido.p50Horas)} detalhe={`mediana · ${numero(r.solicitadoAteTransferido.observados)} repasses`} />
          <Kpi rotulo="Pedido → transferência · p95" valor={textoHoras(r.solicitadoAteTransferido.p95Horas)} detalhe="95% chegam até aqui" />
          <Kpi rotulo="Aprovação → transferência" valor={textoHoras(r.aprovadoAteTransferido.p50Horas)} detalhe={`mediana · ${numero(r.aprovadoAteTransferido.observados)} repasses`} />
          <Kpi rotulo="Aprovação → transferência · p95" valor={textoHoras(r.aprovadoAteTransferido.p95Horas)} detalhe="95% chegam até aqui" />
        </div>
        {estados.length === 0 ? (
          <p data-testid="financeiro-sem-abertos" className="text-sm text-ink-soft">
            Nenhum repasse aberto (todos pagos ou cancelados).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Repasses abertos por idade" className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className={THEAD}>
                  <th className="py-2 pr-3 font-normal">Estado</th>
                  {FAIXAS.map((f) => (
                    <th key={f.key} className={TH}>
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {estados.map((estado) => (
                  <tr key={estado} data-testid="financeiro-aging" className="border-b border-line/60">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {rotuloEstado(estado)}
                    </th>
                    {FAIXAS.map((f) => {
                      const celula = r.aging.find((a) => a.estado === estado && a.faixa === f.key);
                      return (
                        <td key={f.key} className="py-2 pl-3 text-right tabular-nums">
                          {celula ? (
                            <>
                              <div className="font-semibold">{numero(celula.quantidade)}</div>
                              <div className="font-mono text-[10px] text-ink-mute">{dinheiro(celula.valorCents)}</div>
                            </>
                          ) : (
                            <span className="text-ink-mute">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.confirmadosSemMarco > 0 ? (
          <p className="text-sm text-ink-soft">
            {numero(r.confirmadosSemMarco)} repasses confirmados sem data de pedido ficam fora dos prazos.
          </p>
        ) : null}
        <CoberturaNota cobertura={r.cobertura} unidade="repasses" />
      </Bloco>

      <Bloco
        titulo="Exposição a MED e estornos"
        explicacao="Casos registrados no período, cada categoria por si. As categorias podem se sobrepor, por isso não há total."
      >
        <ul className="flex flex-col divide-y divide-line/60">
          {exposicao.map((x) => (
            <li key={x.rotulo} data-testid="financeiro-exposicao" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
              <div>
                <div className="text-sm font-medium">{x.rotulo}</div>
                <div className="font-mono text-[11px] text-ink-mute">{x.explicacao}</div>
              </div>
              <div className={`tabular-nums ${x.valor === null ? "text-ink-mute" : "font-semibold"}`}>
                {x.valor === null ? "não medido" : dinheiro(x.valor)}
              </div>
            </li>
          ))}
        </ul>
        <CoberturaNota cobertura={e.cobertura} />
      </Bloco>
    </div>
  );
}
