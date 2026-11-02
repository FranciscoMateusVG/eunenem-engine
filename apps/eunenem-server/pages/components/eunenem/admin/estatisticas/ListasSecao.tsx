import type { ReactNode } from "react";
import { CoberturaNota } from "./CoberturaNota";
import { ROTULO_ORIGEM } from "./FunilSecao";
import { GraficoBarras, type SerieGrafico } from "./GraficoBarras";
import { dinheiro, dinheiroCurto, numero, textoDias, textoPct, tituloBucket } from "./formato";
import type { ListasData } from "./types";

/**
 * Seção Listas (aperture-lcug3), sobre `admin.analytics.listas`.
 *
 * Universo: listas criadas no período, com administrador elegível (sem QA).
 * Cada bloco traz a própria nota de cobertura do servidor, exibida literalmente.
 */

type Coorte = ListasData["coortes"][number];
type Horizonte = Coorte["horizontes"][number];
const HORIZONTES = [7, 30, 60] as const;

const ROTULO_LEGADO: Record<Coorte["legado"], string> = {
  sim: "Veio do legado",
  nao: "Nova no 2.0",
  desconhecido: "Legado desconhecido",
};

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
    <div data-testid="listas-kpi" className="rounded-xl border border-line p-4">
      <div className="text-sm text-ink-soft">{rotulo}</div>
      <div className="text-2xl font-semibold tabular-nums">{valor}</div>
      <div className="font-mono text-[11px] text-ink-mute">{detalhe}</div>
    </div>
  );
}

const TH = "py-2 pl-3 text-right font-normal";
const THEAD = "border-b border-line text-left font-mono text-[11px] uppercase text-ink-mute";

/** Soma horizontes de várias linhas de coorte (origem × legado são disjuntas). */
export function somarHorizontes(linhas: readonly Coorte[]): Horizonte[] {
  return HORIZONTES.map((dias) => {
    const total = { dias, listasElegiveis: 0, listasImaturas: 0, gmvCents: 0, margemCents: 0, pagamentos: 0, pagamentosComCusto: 0 };
    for (const l of linhas)
      for (const h of l.horizontes)
        if (h.dias === dias) {
          total.listasElegiveis += h.listasElegiveis;
          total.listasImaturas += h.listasImaturas;
          total.gmvCents += h.gmvCents;
          total.margemCents += h.margemCents;
          total.pagamentos += h.pagamentos;
          total.pagamentosComCusto += h.pagamentosComCusto;
        }
    return total;
  });
}

function CelulaHorizonte({ h }: { h: Horizonte }) {
  if (h.listasElegiveis === 0)
    return (
      <td className="py-2 pl-3 text-right text-ink-mute">
        —{h.listasImaturas > 0 ? <div className="font-mono text-[10px]">{numero(h.listasImaturas)} ainda sem D{h.dias}</div> : null}
      </td>
    );
  return (
    <td className="py-2 pl-3 text-right tabular-nums">
      <div className="font-semibold">{dinheiro(Math.round(h.gmvCents / h.listasElegiveis))}</div>
      <div className="font-mono text-[10px] text-ink-mute">
        margem {dinheiro(Math.round(h.margemCents / h.listasElegiveis))} · {numero(h.listasElegiveis)} listas
        {h.listasImaturas > 0 ? ` · ${numero(h.listasImaturas)} ainda sem D${h.dias}` : ""}
      </div>
    </td>
  );
}

function TabelaCoortes({ titulo, linhas }: { titulo: string; linhas: ReadonlyArray<{ chave: string; rotulo: string; horizontes: Horizonte[] }> }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={titulo} className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className={THEAD}>
            <th className="py-2 pr-3 font-normal">{titulo}</th>
            {HORIZONTES.map((d) => (
              <th key={d} className={TH}>
                Até D{d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.chave} data-testid="listas-coorte" className="border-b border-line/60 align-top">
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                {l.rotulo}
              </th>
              {l.horizontes.map((h) => (
                <CelulaHorizonte key={h.dias} h={h} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SERIE_CURVA: readonly SerieGrafico[] = [
  { chave: "pagamentos", nome: "Pagamentos", cor: "bg-plum", corParcial: "bg-plum/40" },
];

export function ListasSecao({ data }: { data: ListasData }) {
  const pp = data.primeiroPresente;
  const porMes = data.meses.map((m) => ({
    chave: m.de,
    rotulo: tituloBucket(m, true),
    horizontes: somarHorizontes(data.coortes.filter((c) => c.de === m.de)),
  }));
  const origens = [...new Set(data.coortes.map((c) => c.origem))];
  const porOrigem = origens.map((o) => ({
    chave: o,
    rotulo: ROTULO_ORIGEM[o],
    horizontes: somarHorizontes(data.coortes.filter((c) => c.origem === o)),
  }));
  const legados = [...new Set(data.coortes.map((c) => c.legado))];
  const porLegado = legados.map((l) => ({
    chave: l,
    rotulo: ROTULO_LEGADO[l],
    horizontes: somarHorizontes(data.coortes.filter((c) => c.legado === l)),
  }));
  const c = data.concentracao;
  const pg = data.pagadores;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi rotulo="Listas criadas" valor={numero(data.listas)} detalhe="no período, sem QA" />
        <Kpi rotulo="Até o 1º presente" valor={textoDias(pp.medianaDias)} detalhe={`mediana · p90 ${textoDias(pp.p90Dias)}`} />
        <Kpi rotulo="Pagantes recorrentes" valor={textoPct(pg.percentualRecorrentes)} detalhe={`${numero(pg.pagadoresRecorrentes)} de ${numero(pg.pagadoresUnicos)} pagantes`} />
        <Kpi rotulo="Top 10 listas" valor={textoPct(c.top10GmvPct)} detalhe="do volume em presentes" />
      </div>

      <Bloco titulo="Tempo até o primeiro presente" explicacao="Quanto tempo uma lista nova leva para receber o primeiro presente pago, e quantas ainda não receberam.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi rotulo="Com presente" valor={numero(pp.listasComPresente)} detalhe="listas" />
          <Kpi rotulo="Sem presente" valor={numero(pp.listasSemPresente)} detalhe="listas" />
          <Kpi rotulo="Mediana" valor={textoDias(pp.medianaDias)} detalhe="entre listas pagas" />
          <Kpi rotulo="p90" valor={textoDias(pp.p90Dias)} detalhe="entre listas pagas" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className={THEAD}>
                <th className="py-2 pr-3 font-normal">Janela</th>
                <th className={TH}>Listas com idade</th>
                <th className={TH}>Sem presente</th>
                <th className={TH}>% sem presente</th>
              </tr>
            </thead>
            <tbody>
              {pp.janelas.map((j) => (
                <tr key={j.dias} data-testid="listas-janela" className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    Primeiros {j.dias} dias
                  </th>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(j.elegiveis)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(j.semPresente)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{textoPct(j.percentualSemPresente)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CoberturaNota cobertura={pp.cobertura} unidade="listas" />
      </Bloco>

      <Bloco
        titulo="Turmas de listas: volume por lista até D7, D30 e D60"
        explicacao="Volume médio em presentes (e margem observada) por lista, contando só os primeiros 7, 30 ou 60 dias de cada uma. Listas novas demais para a janela ficam de fora da média."
      >
        <TabelaCoortes titulo="Mês de criação" linhas={porMes} />
        <TabelaCoortes titulo="Origem" linhas={porOrigem} />
        <TabelaCoortes titulo="Legado" linhas={porLegado} />
        <CoberturaNota cobertura={data.coberturaCoortes} unidade="pagamentos" />
      </Bloco>

      <Bloco titulo="Pagantes" explicacao="Pessoas que pagaram presentes nas listas do período, identificadas pelo e-mail informado no pagamento.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi rotulo="Pagantes únicos" valor={numero(pg.pagadoresUnicos)} detalhe={`${numero(pg.pagamentosAprovados)} pagamentos`} />
          <Kpi rotulo="Recorrentes" valor={numero(pg.pagadoresRecorrentes)} detalhe={`${textoPct(pg.percentualRecorrentes)} dos únicos`} />
          <Kpi rotulo="Pagantes por lista" valor={pg.medianaPorLista === null ? "—" : numero(pg.medianaPorLista)} detalhe="mediana" />
          <Kpi rotulo="p90 por lista" valor={pg.p90PorLista === null ? "—" : numero(pg.p90PorLista)} detalhe="pagantes" />
        </div>
        <CoberturaNota cobertura={pg.cobertura} unidade="pagamentos" />
      </Bloco>

      <Bloco titulo="Listas em risco perto do evento" explicacao="Listas cujo evento está a poucos dias e que ainda não receberam presente ou estão paradas há uma semana.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] text-sm">
            <thead>
              <tr className={THEAD}>
                <th className="py-2 pr-3 font-normal">Evento em</th>
                <th className={TH}>Listas</th>
                <th className={TH}>Sem 1º presente</th>
                <th className={TH}>Sem pagamento há 7 dias</th>
              </tr>
            </thead>
            <tbody>
              {data.risco.faixas.map((f) => (
                <tr key={f.deDias} data-testid="listas-risco" className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {f.deDias}–{f.ateDias} dias
                  </th>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(f.listas)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(f.semPrimeiroPresente)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(f.semPagamento7Dias)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.risco.semData > 0 ? (
          <p className="text-sm text-ink-soft">{numero(data.risco.semData)} listas sem data de evento ficam fora destas faixas.</p>
        ) : null}
        <CoberturaNota cobertura={data.risco.cobertura} unidade="listas" />
      </Bloco>

      <div className="flex min-w-0 flex-col gap-3">
        <GraficoBarras
          titulo="Compras em relação ao dia do evento"
          explicacao="Pagamentos aprovados de D-30 (um mês antes) a D+7 (uma semana depois do evento). D0 é o dia do evento."
          series={SERIE_CURVA}
          barras={data.curvaEvento.dias.map((d) => {
            const rotulo = d.diaRelativo === 0 ? "D0" : d.diaRelativo > 0 ? `D+${d.diaRelativo}` : `D${d.diaRelativo}`;
            return {
              chave: String(d.diaRelativo),
              rotulo,
              titulo: `${rotulo}: ${numero(d.pagamentos)} pagamentos · ${dinheiro(d.gmvCents)}`,
              parcial: false,
              valores: { pagamentos: d.pagamentos },
            };
          })}
          formatar={numero}
          testId="listas-curva"
        />
        <CoberturaNota cobertura={data.curvaEvento.cobertura} unidade="listas" />
      </div>

      <Bloco titulo="Concentração" explicacao="Quanto do volume e da margem vem das 10 maiores listas do período.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi rotulo="Top 10 · volume" valor={textoPct(c.top10GmvPct)} detalhe={`de ${dinheiroCurto(c.gmvCents)}`} />
          <Kpi rotulo="Top 10 · margem" valor={textoPct(c.top10MargemPct)} detalhe={`de ${dinheiroCurto(c.margemCents)}`} />
          <Kpi rotulo="Listas" valor={numero(c.listas)} detalhe="no período" />
          <Kpi rotulo="Sem receita" valor={numero(c.listasSemReceita)} detalhe="listas sem tarifa EuNeném" />
        </div>
        <CoberturaNota cobertura={c.cobertura} unidade="pagamentos" />
      </Bloco>
    </div>
  );
}
